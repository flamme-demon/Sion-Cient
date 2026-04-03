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
  private var cachedWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Inject JS interface for voice service control once WebView is ready
    val activity = this
    window.decorView.post(object : Runnable {
      override fun run() {
        val webView = findWebView()
        if (webView != null) {
          cachedWebView = webView
          webView.addJavascriptInterface(VoiceServiceBridge(activity), "__SION__")
          // Allow media to play without user gesture (needed for LiveKit audio)
          webView.settings.mediaPlaybackRequiresUserGesture = false
        } else {
          window.decorView.postDelayed(this, 200)
        }
      }
    })

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
        runOnUiThread {
          val webView = cachedWebView ?: findWebView()
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

  override fun onPause() {
    if (VoiceCallService.isRunning) {
      // Skip TauriActivity.onPause() which pauses WebView
      // Call Activity.onPause() directly for lifecycle
      try {
        val method = android.app.Activity::class.java.getDeclaredMethod("onPause")
        method.isAccessible = true
        method.invoke(this)
      } catch (_: Exception) {
        super.onPause()
      }
      return
    }
    super.onPause()
  }

  override fun onStop() {
    if (VoiceCallService.isRunning) {
      // Skip TauriActivity.onStop() which suspends WebView JS
      // Call Activity.onStop() directly
      try {
        val method = android.app.Activity::class.java.getDeclaredMethod("onStop")
        method.isAccessible = true
        method.invoke(this)
      } catch (_: Exception) {
        super.onStop()
      }
      // Re-resume WebView to counteract any pause
      cachedWebView?.onResume()
      return
    }
    super.onStop()
  }

  override fun onResume() {
    super.onResume()
  }

  override fun onDestroy() {
    voiceActionReceiver?.let { unregisterReceiver(it) }
    super.onDestroy()
  }

  fun findWebView(): WebView? {
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
