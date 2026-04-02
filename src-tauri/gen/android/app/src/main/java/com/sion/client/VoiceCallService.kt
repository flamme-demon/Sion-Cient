package com.sion.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class VoiceCallService : Service() {

    companion object {
        const val CHANNEL_ID = "sion_voice_call"
        const val NOTIFICATION_ID = 1001
        const val ACTION_MUTE = "com.sion.client.MUTE"
        const val ACTION_DEAFEN = "com.sion.client.DEAFEN"
        const val ACTION_DISCONNECT = "com.sion.client.DISCONNECT"
        const val EXTRA_CHANNEL_NAME = "channel_name"
        const val EXTRA_IS_MUTED = "is_muted"
        const val EXTRA_IS_DEAFENED = "is_deafened"

        fun start(context: Context, channelName: String, isMuted: Boolean = false, isDeafened: Boolean = false) {
            val intent = Intent(context, VoiceCallService::class.java).apply {
                putExtra(EXTRA_CHANNEL_NAME, channelName)
                putExtra(EXTRA_IS_MUTED, isMuted)
                putExtra(EXTRA_IS_DEAFENED, isDeafened)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiceCallService::class.java))
        }

        fun update(context: Context, channelName: String, isMuted: Boolean, isDeafened: Boolean) {
            // Re-start with new extras to update notification
            start(context, channelName, isMuted, isDeafened)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelName = intent?.getStringExtra(EXTRA_CHANNEL_NAME) ?: "Voice"
        val isMuted = intent?.getBooleanExtra(EXTRA_IS_MUTED, false) ?: false
        val isDeafened = intent?.getBooleanExtra(EXTRA_IS_DEAFENED, false) ?: false

        // Handle action intents
        when (intent?.action) {
            ACTION_MUTE, ACTION_DEAFEN, ACTION_DISCONNECT -> {
                // Send action to WebView via broadcast
                val actionIntent = Intent("com.sion.client.VOICE_ACTION").apply {
                    putExtra("action", intent.action)
                    setPackage(packageName)
                }
                sendBroadcast(actionIntent)
                if (intent.action == ACTION_DISCONNECT) {
                    stopSelf()
                    return START_NOT_STICKY
                }
            }
        }

        val notification = buildNotification(channelName, isMuted, isDeafened)
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Appel vocal",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Notification pendant un appel vocal"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(channelName: String, isMuted: Boolean, isDeafened: Boolean): Notification {
        // Open app intent
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Mute action
        val muteIntent = PendingIntent.getService(
            this, 1,
            Intent(this, VoiceCallService::class.java).apply { action = ACTION_MUTE },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Deafen action
        val deafenIntent = PendingIntent.getService(
            this, 2,
            Intent(this, VoiceCallService::class.java).apply { action = ACTION_DEAFEN },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Disconnect action
        val disconnectIntent = PendingIntent.getService(
            this, 3,
            Intent(this, VoiceCallService::class.java).apply { action = ACTION_DISCONNECT },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteLabel = if (isMuted) "Unmute" else "Mute"
        val deafenLabel = if (isDeafened) "Undeafen" else "Sourdine"
        val statusText = buildString {
            append("En appel")
            if (isMuted) append(" · Muté")
            if (isDeafened) append(" · Sourdine")
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(channelName)
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(0, muteLabel, muteIntent)
            .addAction(0, deafenLabel, deafenIntent)
            .addAction(0, "Quitter", disconnectIntent)
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
