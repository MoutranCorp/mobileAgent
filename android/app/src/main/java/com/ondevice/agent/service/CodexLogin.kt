package com.ondevice.agent.service

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/**
 * Native, on-device Codex sign-in. Drives `codex login --device-auth` or
 * `codex login --with-api-key` inside the Debian guest so the credentials land
 * in /root/.codex, which is the same home directory used by the broker-spawned
 * Codex app-server.
 */
object CodexLogin {

    enum class Phase { IDLE, CHECKING, STARTING, AWAITING_BROWSER, VERIFYING, DONE, ERROR }
    data class State(
        val phase: Phase = Phase.IDLE,
        val url: String? = null,
        val userCode: String? = null,
        val message: String = "",
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    @Volatile private var proc: Process? = null

    fun refresh(ctx: Context) {
        val ph = _state.value.phase
        if (ph == Phase.STARTING || ph == Phase.AWAITING_BROWSER || ph == Phase.VERIFYING) return
        Thread {
            runCatching {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) return@Thread
                val msg = statusText(rt)
                _state.value = if (isSignedIn(msg, authFile(rt)))
                    State(Phase.DONE, message = msg.ifEmpty { "Signed in to Codex." })
                else
                    State(Phase.IDLE, message = msg)
            }.onFailure {
                RuntimeController.log("[codex-login] status error: ${it.message}")
            }
        }.apply { isDaemon = true; start() }
    }

    fun startDeviceAuth(ctx: Context) {
        val ph = _state.value.phase
        if (ph == Phase.STARTING || ph == Phase.AWAITING_BROWSER || ph == Phase.VERIFYING) return
        _state.value = State(Phase.STARTING, message = "Starting Codex sign-in...")
        Thread {
            val out = StringBuilder()
            try {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) {
                    _state.value = State(Phase.ERROR, message = "Start the runtime first, then sign in.")
                    return@Thread
                }
                RuntimeController.log("[codex-login] running `codex login --device-auth`...")
                val p = rt.startGuestCommand(
                    "exec script -qec 'stty cols 400 rows 100 2>/dev/null; codex login --device-auth' /dev/null"
                )
                proc = p
                val reader = p.inputStream.bufferedReader()
                val buf = CharArray(4096)
                var logged = 0
                while (true) {
                    val n = reader.read(buf); if (n < 0) break
                    out.append(buf, 0, n)
                    val clean = stripAnsi(out.toString())
                    if (clean.length > logged) {
                        val chunk = clean.substring(logged).trim()
                        if (chunk.isNotEmpty()) RuntimeController.log("[codex-login] " + TOKEN_RE.replace(chunk, "[token]"))
                        logged = clean.length
                    }
                    if (_state.value.url == null) {
                        val url = URL_RE.find(clean)?.value
                        val code = CODE_RE.find(clean)?.groupValues?.getOrNull(1)
                        if (url != null) {
                            _state.value = State(
                                Phase.AWAITING_BROWSER,
                                url,
                                code,
                                if (code != null) "Open the link, enter the code, and finish in your browser."
                                else "Open the link and finish Codex sign-in in your browser.",
                            )
                        }
                    }
                    if (SUCCESS_RE.containsMatchIn(clean)) {
                        runCatching { p.destroyForcibly() }
                        break
                    }
                }
                val code = runCatching { p.waitFor() }.getOrDefault(-1)
                proc = null
                val status = statusText(rt)
                if (code == 0 || isSignedIn(status, authFile(rt)) || SUCCESS_RE.containsMatchIn(stripAnsi(out.toString()))) {
                    _state.value = State(Phase.DONE, message = status.ifEmpty { "Signed in to Codex. New Codex sessions can use it." })
                } else {
                    _state.value = State(Phase.ERROR, message = "Codex sign-in did not complete (exit $code). Check the runtime log, then try again.")
                }
            } catch (t: Throwable) {
                proc = null
                RuntimeController.log("[codex-login] error: ${t.message}")
                _state.value = State(Phase.ERROR, message = t.message ?: "Codex sign-in failed")
            }
        }.apply { isDaemon = true; start() }
    }

    fun signInWithApiKey(ctx: Context, keyRaw: String) {
        val key = keyRaw.trim()
        if (key.isEmpty()) return
        if (_state.value.phase == Phase.VERIFYING) return
        _state.value = State(Phase.VERIFYING, message = "Saving Codex API key...")
        Thread {
            val out = StringBuilder()
            try {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) {
                    _state.value = State(Phase.ERROR, message = "Start the runtime first, then sign in.")
                    return@Thread
                }
                val p = rt.startGuestCommand("codex login --with-api-key")
                proc = p
                p.outputStream.write((key + "\n").toByteArray(Charsets.UTF_8))
                p.outputStream.flush()
                p.outputStream.close()
                val reader = p.inputStream.bufferedReader()
                reader.forEachLine { line ->
                    val clean = stripAnsi(line)
                    out.append(clean).append('\n')
                    if (clean.isNotBlank()) RuntimeController.log("[codex-login] " + TOKEN_RE.replace(clean, "[token]"))
                }
                val code = runCatching { p.waitFor() }.getOrDefault(-1)
                proc = null
                val status = statusText(rt)
                if (code == 0 || isSignedIn(status, authFile(rt))) {
                    _state.value = State(Phase.DONE, message = status.ifEmpty { "Codex API key saved." })
                } else {
                    _state.value = State(Phase.ERROR, message = "Could not save Codex API key (exit $code).")
                }
            } catch (t: Throwable) {
                proc = null
                RuntimeController.log("[codex-login] API key error: ${t.message}")
                _state.value = State(Phase.ERROR, message = t.message ?: "Codex API-key sign-in failed")
            }
        }.apply { isDaemon = true; start() }
    }

    fun cancel() {
        runCatching { proc?.destroyForcibly() }
        proc = null
        _state.value = State()
    }

    fun reset() {
        if (proc == null) _state.value = State()
    }

    private fun statusText(rt: ProotRuntime): String = runCatching {
        val p = rt.startGuestCommand("codex login status")
        val text = p.inputStream.bufferedReader().readText()
        runCatching { p.waitFor() }
        stripAnsi(text).trim()
    }.getOrDefault("")

    private fun isSignedIn(status: String, auth: File): Boolean =
        auth.exists() || Regex("(?i)logged in|authenticated|using chatgpt|api key").containsMatchIn(status)

    private fun authFile(rt: ProotRuntime) = File(rt.rootfs, "root/.codex/auth.json")

    private val ESC = 27.toChar().toString()
    private val BEL = 7.toChar().toString()
    private fun stripAnsi(s: String): String = s
        .replace(Regex(ESC + "\\][^" + BEL + ESC + "]*(" + BEL + "|" + ESC + "\\\\)"), "")
        .replace(Regex(ESC + "\\[[0-9;?]*[ -/]*[@-~]"), "")
        .replace(Regex(ESC + "[@-Z\\\\-_]"), "")
        .replace("\r", "")

    private val URL_RE = Regex("https://[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]+")
    private val CODE_RE = Regex("(?i)(?:code|enter)\\D+([A-Z0-9][A-Z0-9-]{3,})")
    private val TOKEN_RE = Regex("(sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{80,})")
    private val SUCCESS_RE = Regex("(?i)(logged in|login successful|authenticated|successfully)")
}
