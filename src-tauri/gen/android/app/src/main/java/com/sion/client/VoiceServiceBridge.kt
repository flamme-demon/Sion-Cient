package com.sion.client

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface

class VoiceServiceBridge(private val context: Context) {

    companion object {
        const val DEMANDE_MICRO = 4242
        /** Réponse à la dernière demande du micro : « attente », « accordée »
         *  ou « refusée » (posée par MainActivity.onRequestPermissionsResult). */
        @Volatile var reponseMicro: String = "attente"
    }

    /** Voix Rust : le micro Java de WebRTC exige l'autorisation accordée à
     *  l'exécution (l'ancienne voix JS l'obtenait par le WebView). */
    @JavascriptInterface
    fun hasMicPermission(): Boolean =
        androidx.core.content.ContextCompat.checkSelfPermission(
            context, android.Manifest.permission.RECORD_AUDIO
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED

    @JavascriptInterface
    fun requestMicPermission() {
        val activity = context as? android.app.Activity ?: return
        reponseMicro = "attente"
        activity.runOnUiThread {
            androidx.core.app.ActivityCompat.requestPermissions(
                activity, arrayOf(android.Manifest.permission.RECORD_AUDIO), DEMANDE_MICRO
            )
        }
    }

    @JavascriptInterface
    fun micPermissionState(): String = if (hasMicPermission()) "accordée" else reponseMicro

    /** Lien externe : l'application par défaut (navigateur, mail…). Sans ça,
     *  le lien s'ouvrait dans le WebView de Sion — `open_url` côté Rust n'a
     *  pas d'équivalent Android. */
    @JavascriptInterface
    fun openUrl(url: String): Boolean {
        val uri = android.net.Uri.parse(url)
        if (uri.scheme !in setOf("http", "https", "mailto", "tel", "geo")) return false
        return try {
            val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (_: android.content.ActivityNotFoundException) {
            false
        }
    }

    @JavascriptInterface
    fun startVoiceService(channelName: String, isMuted: Boolean, isDeafened: Boolean) {
        VoiceCallService.start(context, channelName, isMuted, isDeafened)
    }

    @JavascriptInterface
    fun stopVoiceService() {
        VoiceCallService.stop(context)
    }

    @JavascriptInterface
    fun updateVoiceService(channelName: String, isMuted: Boolean, isDeafened: Boolean) {
        VoiceCallService.update(context, channelName, isMuted, isDeafened)
    }

    @JavascriptInterface
    fun isVoiceServiceRunning(): Boolean {
        return VoiceCallService.isRunning
    }

    @JavascriptInterface
    fun setSpeakerOn(on: Boolean) {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        audioManager.isSpeakerphoneOn = on
    }

    @JavascriptInterface
    fun getPendingAction(): String {
        return VoiceCallService.consumePendingAction()
    }

    @JavascriptInterface
    fun requestBatteryOptimizationExemption() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
        }
    }

    @JavascriptInterface
    fun startPushListener(topicUrl: String) {
        // Save topic URL for polling
        context.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
            .edit().putString("topic_url", topicUrl).apply()

        // Start periodic polling via WorkManager (survives app kill)
        val workRequest = androidx.work.PeriodicWorkRequestBuilder<PushPollWorker>(
            15, java.util.concurrent.TimeUnit.MINUTES  // minimum interval
        ).build()

        androidx.work.WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "sion_push_poll",
            androidx.work.ExistingPeriodicWorkPolicy.KEEP,
            workRequest
        )
        android.util.Log.i("SionPush", "Push poll worker scheduled for topic: $topicUrl")

        // Request battery optimization exemption for persistent connection
        requestBatteryOptimizationExemption()

        // Start foreground SSE service for real-time push
        NtfyListenerService.start(context, topicUrl)
    }

    @JavascriptInterface
    fun stopPushListener() {
        androidx.work.WorkManager.getInstance(context).cancelUniqueWork("sion_push_poll")
        NtfyListenerService.stop(context)
    }

    @JavascriptInterface
    fun saveRoomName(roomId: String, roomName: String) {
        context.getSharedPreferences("sion_rooms", Context.MODE_PRIVATE)
            .edit().putString(roomId, roomName).apply()
    }

    @JavascriptInterface
    fun saveRoomInfo(roomId: String, roomName: String, isDM: Boolean) {
        context.getSharedPreferences("sion_rooms", Context.MODE_PRIVATE)
            .edit()
            .putString(roomId, roomName)
            .putString("${roomId}_dm", if (isDM) "true" else "false")
            .apply()
    }

    @JavascriptInterface
    fun setNotificationMode(mode: String) {
        context.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
            .edit().putString("notification_mode", mode).apply()
    }
}
