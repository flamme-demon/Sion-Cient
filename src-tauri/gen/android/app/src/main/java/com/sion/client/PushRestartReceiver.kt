package com.sion.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Restarts the NtfyListenerService after device boot or app update.
 */
class PushRestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED) {
            val topicUrl = context.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
                .getString("topic_url", null) ?: return

            android.util.Log.i("SionPush", "Boot completed, restarting push listener")
            val serviceIntent = Intent(context, NtfyListenerService::class.java).apply {
                putExtra(NtfyListenerService.EXTRA_TOPIC_URL, topicUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        }
    }
}
