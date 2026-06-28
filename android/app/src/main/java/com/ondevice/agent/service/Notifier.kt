package com.ondevice.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.ondevice.agent.MainActivity
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * Posts user-facing notifications for things that finish in the background — most
 * importantly scheduled (cron) jobs — so the user is told even when the app UI is
 * fully closed. The in-app `notify` toast only reaches a live WebView/WS; this
 * path lives entirely in the always-running foreground service process.
 *
 * The broker signals these by writing a one-line marker to its stderr:
 *
 *     @@NATIVE_NOTIFY@@ {"title":"…","text":"…","level":"success"}
 *
 * which RuntimeLauncher's output pump detects (it merges stderr into stdout) and
 * routes here. Posted on a DISTINCT, alerting channel — separate from the silent
 * IMPORTANCE_LOW "Agent runtime" ongoing-service channel — so it actually buzzes.
 */
object Notifier {
    const val MARKER = "@@NATIVE_NOTIFY@@"
    private const val CHANNEL_ID = "agent_jobs"
    private const val CHANNEL_NAME = "Background jobs"
    private const val CHANNEL_DESC = "Alerts when a scheduled job finishes"

    // Distinct ids (above the ongoing service's NOTIF_ID=42) so each completion
    // stacks instead of replacing the last; wraps to stay in a sane range.
    private val seq = AtomicInteger(1000)

    /** Parse a `@@NATIVE_NOTIFY@@ {json}` marker line and post it. Returns true if
     *  the line was a marker (so the caller can avoid logging the raw payload). */
    fun handleMarkerLine(ctx: Context, line: String): Boolean {
        val trimmed = line.trim()
        if (!trimmed.startsWith(MARKER)) return false
        val json = trimmed.substring(MARKER.length).trim()
        runCatching {
            val o = JSONObject(json)
            post(ctx, o.optString("title", "On-Device Agent"), o.optString("text", ""))
        }
        return true
    }

    fun post(ctx: Context, title: String, text: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        ensureChannel(nm)
        val tap = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(ctx, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(ctx)
        }
        val notif = builder
            .setContentTitle(title.ifBlank { "On-Device Agent" })
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        val id = seq.getAndUpdate { if (it >= 9000) 1000 else it + 1 }
        runCatching { nm.notify(id, notif) }
    }

    private fun ensureChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT)
            .apply { description = CHANNEL_DESC }
        nm.createNotificationChannel(ch)
    }
}
