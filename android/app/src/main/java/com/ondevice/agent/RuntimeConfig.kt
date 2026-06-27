package com.ondevice.agent

import android.content.Context
import androidx.core.content.edit

/**
 * Central runtime configuration. The broker listens on loopback; the UI (WebView
 * or native client) and the Metro dev client all talk to 127.0.0.1, which is
 * shared across proot because proot is ptrace-based, not a network container.
 */
object RuntimeConfig {
    const val DEFAULT_HOST = "127.0.0.1"
    const val DEFAULT_PORT = 8765

    private const val PREFS = "runtime_config"
    private const val KEY_URL = "broker_url_override"
    private const val KEY_PROFILE = "default_profile"

    fun httpUrl(host: String = DEFAULT_HOST, port: Int = DEFAULT_PORT) = "http://$host:$port/"
    fun wsUrl(host: String = DEFAULT_HOST, port: Int = DEFAULT_PORT) = "ws://$host:$port"

    /**
     * The URL the WebView loads. Defaults to the on-device broker, but can be
     * overridden (e.g. to a broker running on a laptop reached via `adb reverse
     * tcp:8765 tcp:8765`) so the whole UI is usable before the on-device
     * bootstrap is provisioned.
     */
    fun brokerUrl(ctx: Context): String =
        normalizeLoopback(
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_URL, httpUrl()) ?: httpUrl()
        )

    fun setBrokerUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString(KEY_URL, normalizeLoopback(url)) }
    }

    /**
     * The on-device broker serves PLAIN HTTP on loopback. If the broker URL ever gets
     * saved as `https://127.0.0.1…` (e.g. after testing another site, or a stray
     * scheme), the WebView's TLS handshake to the http server fails with
     * ERR_SSL_PROTOCOL_ERROR and the page renders blank. Coerce loopback https→http so
     * that can't happen.
     */
    private fun normalizeLoopback(url: String): String {
        val u = url.trim()
        return if (Regex("^https://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:|/|$)", RegexOption.IGNORE_CASE).containsMatchIn(u))
            u.replaceFirst(Regex("^https://", RegexOption.IGNORE_CASE), "http://")
        else u
    }

    fun defaultProfile(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PROFILE, "claude-max")
            ?: "claude-max"

    fun setDefaultProfile(ctx: Context, profile: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString(KEY_PROFILE, profile) }
    }
}
