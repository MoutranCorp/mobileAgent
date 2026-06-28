package com.ondevice.agent.service

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Native, on-device Claude Code updater. Runs the CLI's built-in self-update
 * (`claude update`) inside the guest — in a PTY via util-linux `script`, the same
 * way ClaudeLogin drives `claude setup-token` — and reports the resulting version.
 *
 * Lives in the APK (Runtime screen) on purpose: it's a runtime-management action,
 * available even when the broker/web UI isn't up, and it updates the very binary
 * the broker spawns. A refreshed CLI applies to NEW agent sessions; Stop & Start
 * the runtime to move every live session onto it.
 */
object ClaudeUpdate {

    enum class Phase { IDLE, UPDATING, DONE, ERROR }
    data class State(val phase: Phase = Phase.IDLE, val version: String = "", val message: String = "")

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    /** Best-effort: read the currently-installed version for display. */
    fun refresh(ctx: Context) {
        if (_state.value.phase == Phase.UPDATING) return
        Thread {
            runCatching {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) return@Thread
                val v = readVersion(rt)
                if (v != null) _state.value = _state.value.copy(version = v)
            }
        }.apply { isDaemon = true; start() }
    }

    /** Run `claude update` in the guest, streaming progress to the runtime log. */
    fun update(ctx: Context) {
        if (_state.value.phase == Phase.UPDATING) return
        _state.value = State(Phase.UPDATING, _state.value.version, "Updating Claude Code…")
        Thread {
            val out = StringBuilder()
            try {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) {
                    _state.value = State(Phase.ERROR, _state.value.version, "Start the runtime first, then update.")
                    return@Thread
                }
                RuntimeController.log("[update] running `claude update`…")
                // A PTY (script) keeps the ink-based CLI happy, matching ClaudeLogin.
                val p = rt.startGuestCommand(
                    "exec script -qec 'stty cols 200 rows 100 2>/dev/null; claude update' /dev/null"
                )
                val reader = p.inputStream.bufferedReader()
                val buf = CharArray(4096)
                var logged = 0
                while (true) {
                    val n = reader.read(buf); if (n < 0) break
                    out.append(buf, 0, n)
                    val clean = stripAnsi(out.toString())
                    if (clean.length > logged) {
                        val chunk = clean.substring(logged).trim()
                        if (chunk.isNotEmpty()) RuntimeController.log("[update] $chunk")
                        logged = clean.length
                    }
                }
                val code = runCatching { p.waitFor() }.getOrDefault(-1)
                val text = stripAnsi(out.toString())
                val version = readVersion(rt) ?: parseVersion(text) ?: _state.value.version
                val failed = code != 0 || ERROR_RE.containsMatchIn(text)
                if (failed && !SUCCESS_RE.containsMatchIn(text)) {
                    _state.value = State(Phase.ERROR, version,
                        "Update failed (exit $code). Check the runtime log.")
                } else {
                    val upToDate = ALREADY_RE.containsMatchIn(text)
                    _state.value = State(Phase.DONE, version,
                        (if (upToDate) "Already up to date" else "Updated ✓") +
                            (if (version.isNotEmpty()) " — $version" else "") +
                            ". New agents use it; Stop & Start the runtime to move every session onto it.")
                }
            } catch (t: Throwable) {
                RuntimeController.log("[update] error: ${t.message}")
                _state.value = State(Phase.ERROR, _state.value.version, t.message ?: "update failed")
            }
        }.apply { isDaemon = true; start() }
    }

    private fun readVersion(rt: ProotRuntime): String? = runCatching {
        val p = rt.startGuestCommand("claude --version")
        val text = p.inputStream.bufferedReader().readText()
        runCatching { p.waitFor() }
        parseVersion(stripAnsi(text))
    }.getOrNull()

    private fun parseVersion(s: String): String? =
        Regex("\\d+\\.\\d+\\.\\d+[-.\\w]*").find(s)?.value

    // Strip ANSI/VT escapes so version/result regexes see clean text — the ink CLI's
    // spinner/cursor control would otherwise split them. ESC/BEL are built from char
    // codes (27/7) to keep this source free of literal control characters.
    private val ESC = 27.toChar().toString()
    private val BEL = 7.toChar().toString()
    private fun stripAnsi(s: String): String = s
        .replace(Regex(ESC + "\\][^" + BEL + ESC + "]*(" + BEL + "|" + ESC + "\\\\)"), "") // OSC
        .replace(Regex(ESC + "\\[[0-9;?]*[ -/]*[@-~]"), "")                                // CSI
        .replace(Regex(ESC + "[@-Z\\\\-_]"), "")                                           // other ESC seqs
        .replace("\r", "")

    private val SUCCESS_RE = Regex("(?i)(updated|up to date|up-to-date|already|installed|latest)")
    private val ALREADY_RE = Regex("(?i)(already (on |up)|up[- ]to[- ]date|latest version)")
    private val ERROR_RE = Regex("(?i)(error|failed|not found|cannot|enoent|permission denied)")
}
