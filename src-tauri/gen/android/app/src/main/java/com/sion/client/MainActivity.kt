package com.sion.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {

  private var voiceActionReceiver: BroadcastReceiver? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Inject JS interface for voice service control
    // Delayed to ensure WebView is ready
    window.decorView.postDelayed({
      val webView = findWebView()
      webView?.addJavascriptInterface(VoiceServiceBridge(this), "__SION__")
    }, 2000)

    // Listen for voice actions from the foreground service notification
    voiceActionReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val action = intent?.getStringExtra("action") ?: return
        val jsAction = when (action) {
          VoiceCallService.ACTION_MUTE -> "mute"
          VoiceCallService.ACTION_DEAFEN -> "deafen"
          VoiceCallService.ACTION_DISCONNECT -> "disconnect"
          else -> return
        }
        // Emit event to WebView
        runOnUiThread {
          val webView = findWebView()
          webView?.evaluateJavascript(
            "window.__SION_VOICE_ACTION__?.('$jsAction')",
            null
          )
        }
      }
    }

    val filter = IntentFilter("com.sion.client.VOICE_ACTION")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(voiceActionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(voiceActionReceiver, filter)
    }
  }

  override fun onDestroy() {
    voiceActionReceiver?.let { unregisterReceiver(it) }
    super.onDestroy()
  }

  private fun findWebView(): WebView? {
    return try {
      val decorView = window.decorView
      findWebViewRecursive(decorView as android.view.ViewGroup)
    } catch (e: Exception) {
      null
    }
  }

  private fun findWebViewRecursive(viewGroup: android.view.ViewGroup): WebView? {
    for (i in 0 until viewGroup.childCount) {
      val child = viewGroup.getChildAt(i)
      if (child is WebView) return child
      if (child is android.view.ViewGroup) {
        val found = findWebViewRecursive(child)
        if (found != null) return found
      }
    }
    return null
  }
}
