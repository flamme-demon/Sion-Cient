package com.sion.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Relance l'écoute ntfy au démarrage du téléphone et après une mise à jour
 * de Sion (sans quoi les notifications attendaient que l'on rouvre Sion).
 */
class PushRestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED || intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            val topicUrl = context.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
                .getString("topic_url", null) ?: return

            android.util.Log.i("SionPush", "${intent.action} : écoute relancée")
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
