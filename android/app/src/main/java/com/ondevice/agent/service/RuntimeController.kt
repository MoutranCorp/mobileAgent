package com.ondevice.agent.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class RuntimeState {
    STOPPED,
    STARTING,
    BOOTSTRAP_MISSING, // app installed but the Termux/proot bootstrap isn't provisioned yet
    RUNNING,
    ERROR,
}

/**
 * Process-wide singleton holding the runtime's observable state. The foreground
 * service drives it; the Compose UI observes it. Decoupling the UI from the
 * service this way means the transcript/WebView survives Activity recreation
 * while the service keeps the broker + Metro alive.
 */
object RuntimeController {
    private const val MAX_LOG_LINES = 1000

    private val _state = MutableStateFlow(RuntimeState.STOPPED)
    val state: StateFlow<RuntimeState> = _state.asStateFlow()

    private val _logs = MutableStateFlow<List<String>>(emptyList())
    val logs: StateFlow<List<String>> = _logs.asStateFlow()

    private val _detail = MutableStateFlow("")
    val detail: StateFlow<String> = _detail.asStateFlow()

    fun setState(s: RuntimeState, detail: String = "") {
        _state.value = s
        if (detail.isNotEmpty()) _detail.value = detail
    }

    fun log(line: String) {
        val next = (_logs.value + line.trimEnd())
        _logs.value = if (next.size > MAX_LOG_LINES) next.takeLast(MAX_LOG_LINES) else next
    }

    fun clearLogs() {
        _logs.value = emptyList()
    }
}
