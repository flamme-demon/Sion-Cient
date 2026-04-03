package com.sion.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import android.os.PowerManager
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

        var isRunning = false
            private set

        private val pendingActions = mutableListOf<String>()
        private var currentMuted = false
        private var currentDeafened = false
        private var currentChannelName = "Voice"

        fun consumePendingAction(): String {
            synchronized(pendingActions) {
                if (pendingActions.isEmpty()) return ""
                return pendingActions.removeAt(0)
            }
        }

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
            isRunning = false
            context.stopService(Intent(context, VoiceCallService::class.java))
        }

        fun update(context: Context, channelName: String, isMuted: Boolean, isDeafened: Boolean) {
            if (!isRunning) return
            start(context, channelName, isMuted, isDeafened)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val speakerRunnable = object : Runnable {
        override fun run() {
            if (!isRunning) return
            forceSpeaker()
            handler.postDelayed(this, 2000)
        }
    }

    private fun forceSpeaker() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ : use setCommunicationDevice
            val speaker = am.availableCommunicationDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            }
            if (speaker != null && am.communicationDevice?.type != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                am.setCommunicationDevice(speaker)
            }
        } else {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = true
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        // Acquire partial wake lock to keep CPU running for audio processing
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sion:voicecall").apply {
            acquire()
        }
        isRunning = true

        // Force speaker after WebRTC audio setup (with delay + periodic enforcement)
        handler.postDelayed(speakerRunnable, 3000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle action intents from notification buttons
        when (intent?.action) {
            ACTION_MUTE -> {
                currentMuted = !currentMuted
                // If unmuting, bring app to foreground (Android blocks mic capture in background)
                if (!currentMuted) {
                    val bringToFront = Intent(this, MainActivity::class.java)
                    bringToFront.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    startActivity(bringToFront)
                }
                sendBroadcast(Intent("com.sion.client.VOICE_ACTION").apply {
                    putExtra("action", ACTION_MUTE)
                    setPackage(packageName)
                })
                val notification = buildNotification(currentChannelName, currentMuted, currentDeafened)
                val manager = getSystemService(NotificationManager::class.java)
                manager.notify(NOTIFICATION_ID, notification)
                return START_STICKY
            }
            ACTION_DEAFEN -> {
                currentDeafened = !currentDeafened
                sendBroadcast(Intent("com.sion.client.VOICE_ACTION").apply {
                    putExtra("action", ACTION_DEAFEN)
                    setPackage(packageName)
                })
                val notification = buildNotification(currentChannelName, currentMuted, currentDeafened)
                val manager = getSystemService(NotificationManager::class.java)
                manager.notify(NOTIFICATION_ID, notification)
                return START_STICKY
            }
            ACTION_DISCONNECT -> {
                sendBroadcast(Intent("com.sion.client.VOICE_ACTION").apply {
                    putExtra("action", ACTION_DISCONNECT)
                    setPackage(packageName)
                })
                stopSelf()
                return START_NOT_STICKY
            }
        }

        // Normal start/update — store state
        val channelName = intent?.getStringExtra(EXTRA_CHANNEL_NAME) ?: currentChannelName
        val isMuted = intent?.getBooleanExtra(EXTRA_IS_MUTED, currentMuted) ?: currentMuted
        val isDeafened = intent?.getBooleanExtra(EXTRA_IS_DEAFENED, currentDeafened) ?: currentDeafened
        currentChannelName = channelName
        currentMuted = isMuted
        currentDeafened = isDeafened

        val notification = buildNotification(channelName, isMuted, isDeafened)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        handler.removeCallbacks(speakerRunnable)
        // Restore audio routing
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        } else {
            audioManager.isSpeakerphoneOn = false
            audioManager.mode = AudioManager.MODE_NORMAL
        }
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Appel vocal",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Notification pendant un appel vocal"
                setShowBadge(false)
                setSound(null, null)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(channelName: String, isMuted: Boolean, isDeafened: Boolean): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteIntent = PendingIntent.getService(
            this, 1,
            Intent(this, VoiceCallService::class.java).apply { action = ACTION_MUTE },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val deafenIntent = PendingIntent.getService(
            this, 2,
            Intent(this, VoiceCallService::class.java).apply { action = ACTION_DEAFEN },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val disconnectIntent = PendingIntent.getService(
            this, 3,
            Intent(this, VoiceCallService::class.java).apply { action = ACTION_DISCONNECT },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteIcon = if (isMuted) R.drawable.ic_mic_off else R.drawable.ic_mic
        val muteLabel = if (isMuted) "Unmute" else "Mute"
        val deafenIcon = if (isDeafened) R.drawable.ic_headphone_off else R.drawable.ic_headphone
        val deafenLabel = if (isDeafened) "Undeafen" else "Sourdine"
        val statusText = buildString {
            append("En appel")
            if (isMuted) append(" · Muté")
            if (isDeafened) append(" · Sourdine")
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Sion — $channelName")
            .setContentText(statusText)
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(muteIcon, muteLabel, muteIntent)
            .addAction(deafenIcon, deafenLabel, deafenIntent)
            .addAction(R.drawable.ic_call_end, "Quitter", disconnectIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setSilent(true)
            .build()
    }
}
