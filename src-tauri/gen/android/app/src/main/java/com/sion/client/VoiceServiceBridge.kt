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
}
