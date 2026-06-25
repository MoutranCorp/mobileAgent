package com.ondevice.agent.net

import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** Tiny HTTP health probe for the broker's web endpoint. */
object BrokerHealth {
    private val client = OkHttpClient.Builder()
        .connectTimeout(1500, TimeUnit.MILLISECONDS)
        .readTimeout(1500, TimeUnit.MILLISECONDS)
        .build()

    /**
     * Probe the broker's dedicated /healthz route and require a 2xx — so an
     * unrelated process (or a half-initialized server that 404s) is NOT mistaken
     * for a ready broker. `url` is the base http URL (e.g. http://127.0.0.1:8765/).
     */
    fun isUp(url: String): Boolean = runCatching {
        val healthz = url.trimEnd('/') + "/healthz"
        client.newCall(Request.Builder().url(healthz).get().build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)
}
