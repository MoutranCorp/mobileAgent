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
                var logged = 0
                while (true) {
                    val n = reader.read(buf); if (n < 0) break
                    out.append(buf, 0, n)
                    val clean = stripAnsi(out.toString())
                    // Stream new output to the runtime log (tokens redacted) so a stall is
                    // diagnosable.
                    if (clean.length > logged) {
                        val chunk = clean.substring(logged).trim()
                        if (chunk.isNotEmpty()) RuntimeController.log("[login] " + TOKEN_RE.replace(chunk, "[token]"))
                        logged = clean.length
                    }
                    if (_state.value.url == null) {
                        URL_RE.find(clean)?.value?.let { url ->
                            RuntimeController.log("[login] auth url ready")
                            _state.value = State(Phase.AWAITING_CODE, url, "Open the link, approve, then paste the code below.")
                        }
                    }
                    // Detect success from output too (claude may not exit promptly under
                    // `script`): a printed token or an explicit success line.
                    if (markSuccess(ctx, clean)) { runCatching { p.destroyForcibly() }; break }
                }
                val code = runCatching { p.waitFor() }.getOrDefault(-1)
                proc = null
                val text = stripAnsi(out.toString())
                if (_state.value.phase != Phase.DONE) {
                    val creds = File(rt.rootfs, "root/.claude/.credentials.json").exists()
                    if (markSuccess(ctx, text) || creds || code == 0) {
                        _state.value = State(Phase.DONE, null, "Signed in ✓  Open the Agent tab and send a message.")
                    } else {
                        _state.value = State(Phase.ERROR, null, "Sign-in didn't complete (exit $code). Check the runtime log, then try again.")
                    }
                }
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
                // In a PTY, Enter is CR (\r), not LF — claude's raw-mode (ink) prompt only
                // submits on CR; an \n leaves the code unsubmitted and it hangs. (A PTY's
                // ICRNL also maps CR→NL for canonical readers, so CR is safe either way.)
                p.outputStream.write((code + "\r").toByteArray(Charsets.UTF_8))
                p.outputStream.flush()
            }.onFailure { RuntimeController.log("[login] submit error: ${it.message}") }
        }.apply { isDaemon = true; start() }
        // Watchdog: never leave the UI stuck on "Submitting…".
        Thread {
            Thread.sleep(40_000)
            if (_state.value.phase == Phase.VERIFYING) {
                RuntimeController.log("[login] no completion 40s after code")
                _state.value = State(Phase.ERROR, null, "No response after the code — see the runtime log. The code may be wrong/expired; try again.")
                runCatching { proc?.destroyForcibly() }; proc = null
            }
        }.apply { isDaemon = true; start() }
    }

    /** Persist any printed token and flip to DONE if the output shows success. */
    private fun markSuccess(ctx: Context, text: String): Boolean {
        val tok = TOKEN_RE.find(text)?.value
        val ok = tok != null || SUCCESS_RE.containsMatchIn(text)
        if (ok) {
            tok?.let { runCatching { KeystoreSecrets(ctx).put("CLAUDE_CODE_OAUTH_TOKEN", it) } }
            _state.value = State(Phase.DONE, null, "Signed in ✓  Open the Agent tab and send a message.")
        }
        return ok
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
    private val SUCCESS_RE = Regex("(?i)(login successful|logged in|successfully|authenticat|credentials? (saved|stored|written))")
}
