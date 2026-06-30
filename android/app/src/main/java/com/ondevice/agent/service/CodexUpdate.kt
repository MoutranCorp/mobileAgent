package com.ondevice.agent.service

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Native, on-device Codex CLI updater. Runs `codex update` inside the same
 * Debian guest that the broker uses, so new Codex app-server sessions pick up
 * the refreshed CLI.
 */
object CodexUpdate {

    enum class Phase { IDLE, UPDATING, DONE, ERROR }
    data class State(val phase: Phase = Phase.IDLE, val version: String = "", val message: String = "")

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

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

    fun update(ctx: Context) {
        if (_state.value.phase == Phase.UPDATING) return
        _state.value = State(Phase.UPDATING, _state.value.version, "Updating Codex CLI...")
        Thread {
            val out = StringBuilder()
            try {
                val rt = ProotRuntime(ctx)
                if (!rt.isProvisioned()) {
                    _state.value = State(Phase.ERROR, _state.value.version, "Start the runtime first, then update.")
                    return@Thread
                }
                RuntimeController.log("[codex-update] running `codex update`...")
                val p = rt.startGuestCommand(
                    "exec script -qec 'stty cols 200 rows 100 2>/dev/null; codex update' /dev/null"
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
                        if (chunk.isNotEmpty()) RuntimeController.log("[codex-update] $chunk")
                        logged = clean.length
                    }
                }
                val code = runCatching { p.waitFor() }.getOrDefault(-1)
                val text = stripAnsi(out.toString())
                val version = readVersion(rt) ?: parseVersion(text) ?: _state.value.version
                val failed = code != 0 || ERROR_RE.containsMatchIn(text)
                if (failed && !SUCCESS_RE.containsMatchIn(text)) {
                    _state.value = State(Phase.ERROR, version, "Codex update failed (exit $code). Check the runtime log.")
                } else {
                    val upToDate = ALREADY_RE.containsMatchIn(text)
                    _state.value = State(
                        Phase.DONE,
                        version,
                        (if (upToDate) "Already up to date" else "Updated") +
                            (if (version.isNotEmpty()) " - $version" else "") +
                            ". New Codex sessions use it; Stop & Start the runtime to move every session onto it.",
                    )
                }
            } catch (t: Throwable) {
                RuntimeController.log("[codex-update] error: ${t.message}")
                _state.value = State(Phase.ERROR, _state.value.version, t.message ?: "Codex update failed")
            }
        }.apply { isDaemon = true; start() }
    }

    private fun readVersion(rt: ProotRuntime): String? = runCatching {
        val p = rt.startGuestCommand("codex --version")
        val text = p.inputStream.bufferedReader().readText()
        runCatching { p.waitFor() }
        parseVersion(stripAnsi(text))
    }.getOrNull()

    private fun parseVersion(s: String): String? =
        Regex("\\d+\\.\\d+\\.\\d+[-.\\w]*").find(s)?.value

    private val ESC = 27.toChar().toString()
    private val BEL = 7.toChar().toString()
    private fun stripAnsi(s: String): String = s
        .replace(Regex(ESC + "\\][^" + BEL + ESC + "]*(" + BEL + "|" + ESC + "\\\\)"), "")
        .replace(Regex(ESC + "\\[[0-9;?]*[ -/]*[@-~]"), "")
        .replace(Regex(ESC + "[@-Z\\\\-_]"), "")
        .replace("\r", "")

    private val SUCCESS_RE = Regex("(?i)(updated|up to date|up-to-date|already|installed|latest)")
    private val ALREADY_RE = Regex("(?i)(already (on |up)|up[- ]to[- ]date|latest version)")
    private val ERROR_RE = Regex("(?i)(error|failed|not found|cannot|enoent|permission denied)")
}
