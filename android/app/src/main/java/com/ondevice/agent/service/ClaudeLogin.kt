package com.ondevice.agent.service

import android.content.Context
import com.ondevice.agent.secrets.KeystoreSecrets
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/**
 * Native, on-device Claude sign-in. Drives `claude setup-token` inside the guest
 * (in a real PTY via util-linux `script`, with a wide terminal so the OAuth URL
 * isn't line-wrapped), surfaces the URL for a real-browser Intent, and writes the
 * pasted code straight to the process stdin. `claude setup-token` stores
 * credentials in the shared rootfs at /root/.claude, which the broker's claude
 * engine reads on the next turn — so no broker restart is needed.
 *
 * This lives in the APK (not the web UI) on purpose: native text fields + a real
 * browser + direct stdin are far more reliable than driving it through the WebView.
 */
object ClaudeLogin {

    enum class Phase { IDLE, STARTING, AWAITING_CODE, VERIFYING, DONE, ERROR }
    data class State(val phase: Phase = Phase.IDLE, val url: String? = null, val message: String = "")

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    @Volatile private var proc: Process? = null

    fun start(ctx: Context) {
        val ph = _state.value.phase
        if (ph == Phase.STARTING || ph == Phase.AWAITING_CODE || ph == Phase.VERIFYING) return
        _state.value = State(Phase.STARTING, null, "Starting sign-in…")
        Thread {
            val out = StringBuilder()
            try {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) {
                    _state.value = State(Phase.ERROR, null, "Start the runtime first, then sign in.")
                    return@Thread
                }
                // Wide PTY (stty cols) so claude doesn't hard-wrap the OAuth URL.
                val p = rt.startGuestCommand(
                    "exec script -qec 'stty cols 400 rows 100 2>/dev/null; claude setup-token' /dev/null"
                )
                proc = p
                val reader = p.inputStream.bufferedReader()
                val buf = CharArray(4096)
                while (true) {
                    val n = reader.read(buf); if (n < 0) break
                    out.append(buf, 0, n)
                    if (_state.value.url == null) {
                        val url = URL_RE.find(stripAnsi(out.toString()))?.value
                        if (url != null) {
                            RuntimeController.log("[login] auth url ready")
                            _state.value = State(Phase.AWAITING_CODE, url, "Open the link, approve, then paste the code below.")
                        }
                    }
                }
                val code = runCatching { p.waitFor() }.getOrDefault(-1)
                proc = null
                val text = stripAnsi(out.toString())
                // setup-token may print a long-lived token; persist it as a backstop.
                TOKEN_RE.find(text)?.value?.let { runCatching { KeystoreSecrets(ctx).put("CLAUDE_CODE_OAUTH_TOKEN", it) } }
                val creds = File(rt.rootfs, "root/.claude/.credentials.json").exists()
                val ok = code == 0 || creds || TOKEN_RE.containsMatchIn(text) || text.contains("success", true)
                _state.value = if (ok)
                    State(Phase.DONE, null, "Signed in ✓  Open the Agent tab and send a message.")
                else
                    State(Phase.ERROR, null, "Sign-in didn't complete (exit $code). Try again.")
            } catch (t: Throwable) {
                proc = null
                RuntimeController.log("[login] error: ${t.message}")
                _state.value = State(Phase.ERROR, null, t.message ?: "sign-in failed")
            }
        }.apply { isDaemon = true; start() }
    }

    fun submitCode(codeRaw: String) {
        val p = proc ?: return
        val code = codeRaw.trim()
        if (code.isEmpty()) return
        _state.value = _state.value.copy(phase = Phase.VERIFYING, message = "Submitting code…")
        Thread {
            runCatching {
                p.outputStream.write((code + "\n").toByteArray(Charsets.UTF_8))
                p.outputStream.flush()
            }.onFailure { RuntimeController.log("[login] submit error: ${it.message}") }
        }.apply { isDaemon = true; start() }
    }

    fun cancel() {
        runCatching { proc?.destroyForcibly() }
        proc = null
        _state.value = State(Phase.IDLE)
    }

    fun reset() {
        if (proc == null) _state.value = State(Phase.IDLE)
    }

    // Strip ANSI/VT escapes (ESC = \u001B, BEL = \u0007) so URL/token regexes see
    // clean text — ink's spinner/cursor control would otherwise split them.
    private fun stripAnsi(s: String): String = s
        .replace(Regex("\u001B\\][^\u0007\u001B]*(\u0007|\u001B\\\\)"), "") // OSC
        .replace(Regex("\u001B\\[[0-9;?]*[ -/]*[@-~]"), "")                 // CSI
        .replace(Regex("\u001B[@-Z\\\\-_]"), "")                            // other ESC seqs
        .replace("\r", "")

    private val URL_RE = Regex("https://[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]*oauth[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]*")
    private val TOKEN_RE = Regex("sk-ant-[A-Za-z0-9_-]{20,}")
}
