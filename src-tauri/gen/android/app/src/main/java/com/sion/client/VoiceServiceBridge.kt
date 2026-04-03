package com.sion.client

import android.content.Context
import android.webkit.JavascriptInterface

class VoiceServiceBridge(private val context: Context) {

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

        // Also start the SSE service for real-time when app is alive
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
}
