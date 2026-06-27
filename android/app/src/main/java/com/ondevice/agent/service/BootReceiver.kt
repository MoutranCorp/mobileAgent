package com.ondevice.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts the agent runtime after a device reboot. The app declares
 * RECEIVE_BOOT_COMPLETED; this receiver is what actually acts on it, bringing the
 * foreground service (and with it proot + the broker) back up so an always-on
 * on-device agent survives a restart.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            runCatching { AgentForegroundService.start(context) }
        }
    }
}
