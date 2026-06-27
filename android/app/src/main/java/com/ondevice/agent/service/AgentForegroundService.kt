package com.ondevice.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.ondevice.agent.MainActivity
import com.ondevice.agent.R

/**
 * The foreground service that keeps the whole environment alive.
 *
 * Without this, Doze kills the broker + Metro the moment you switch to the dev
 * client to test your app. It is — per the plan — the single most important
 * piece of Android plumbing in the project. It:
 *   - runs as a foreground service with a persistent notification,
 *   - holds a partial wake lock,
 *   - launches and supervises proot + the Node broker,
 *   - returns START_STICKY so Android restarts it if it's ever killed.
 */
class AgentForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var launcher: RuntimeLauncher
    @Volatile private var started = false

    override fun onCreate() {
        super.onCreate()
        launcher = RuntimeLauncher(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRuntimeAndSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIF_ID, buildNotification())
        acquireWakeLock()
        if (!started) {
            started = true
            // Launch off the main thread; RuntimeLauncher spawns its own pumps.
            Thread { launcher.launch() }.apply { isDaemon = true; start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        runCatching { launcher.stop() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun stopRuntimeAndSelf() {
        runCatching { launcher.stop() }
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OnDeviceAgent::runtime").apply {
            setReferenceCounted(false)
            // Bounded acquire: if the service is OOM-killed without onDestroy, an
            // un-timed lock would keep the CPU awake until reboot. START_STICKY
            // re-delivers onStartCommand, which re-acquires, so a long bound is safe.
            acquire(WAKELOCK_TIMEOUT_MS)
        }
    }

    private fun releaseWakeLock() {
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.service_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = getString(R.string.service_channel_desc) }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, AgentForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        return builder
            .setContentTitle(getString(R.string.service_running))
            .setContentText(getString(R.string.service_running_sub))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "agent_runtime"
        const val NOTIF_ID = 42
        const val ACTION_STOP = "com.ondevice.agent.STOP"
        private const val WAKELOCK_TIMEOUT_MS = 12L * 60L * 60L * 1000L // 12h safety bound

        fun start(ctx: Context) {
            val i = Intent(ctx, AgentForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, AgentForegroundService::class.java).setAction(ACTION_STOP))
        }
    }
}
