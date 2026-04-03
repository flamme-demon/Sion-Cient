package com.sion.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Background service that listens to an ntfy topic via SSE (Server-Sent Events)
 * and shows notifications when Matrix push events arrive.
 */
class NtfyListenerService : Service() {

    companion object {
        const val CHANNEL_ID = "sion_push_messages"
        const val FOREGROUND_CHANNEL_ID = "sion_push_listener"
        const val NOTIFICATION_ID = 2001
        const val EXTRA_TOPIC_URL = "topic_url"
        private var notificationCounter = 0

        var isRunning = false
            private set

        fun start(context: Context, topicUrl: String) {
            // Save topic URL so service can recover after restart
            context.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
                .edit().putString("topic_url", topicUrl).apply()
            val intent = Intent(context, NtfyListenerService::class.java).apply {
                putExtra(EXTRA_TOPIC_URL, topicUrl)
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            isRunning = false
            context.stopService(Intent(context, NtfyListenerService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var listenerThread: Thread? = null
    @Volatile private var shouldRun = true

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        isRunning = true

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sion:pushlistener").apply {
            acquire()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        android.util.Log.i("SionPush", "onStartCommand called")

        val topicUrl = intent?.getStringExtra(EXTRA_TOPIC_URL)
            ?: getSharedPreferences("sion_push", Context.MODE_PRIVATE).getString("topic_url", null)
            ?: run {
                android.util.Log.w("SionPush", "No topic URL, stopping")
                stopSelf()
                return START_NOT_STICKY
            }
        getSharedPreferences("sion_push", Context.MODE_PRIVATE)
            .edit().putString("topic_url", topicUrl).apply()

        android.util.Log.i("SionPush", "Topic: $topicUrl")

        // Start SSE listener in background thread
        // Use local ntfy URL to avoid NAT hairpinning issues
        val localTopicUrl = topicUrl
            .replace("https://push.sionchat.fr", "http://192.168.252.245:8090")
        shouldRun = true
        listenerThread?.interrupt()
        listenerThread = Thread {
            listenToSse("$localTopicUrl/sse")
        }.apply {
            isDaemon = true
            start()
        }

        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        shouldRun = false
        listenerThread?.interrupt()
        listenerThread = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun listenToSse(sseUrl: String) {
        android.util.Log.i("SionPush", "Starting SSE listener: $sseUrl")
        while (shouldRun) {
            try {
                val url = URL(sseUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.setRequestProperty("Accept", "text/event-stream")
                conn.connectTimeout = 30_000
                conn.readTimeout = 0

                android.util.Log.i("SionPush", "SSE connected, response: ${conn.responseCode}")
                val reader = BufferedReader(InputStreamReader(conn.inputStream))

                while (shouldRun) {
                    val line = reader.readLine() ?: break
                    if (line.startsWith("data: ")) {
                        val data = line.removePrefix("data: ")
                        android.util.Log.d("SionPush", "SSE message received")
                        handleSseMessage(data)
                    }
                }

                reader.close()
                conn.disconnect()
                android.util.Log.w("SionPush", "SSE connection closed, reconnecting...")
            } catch (e: Exception) {
                android.util.Log.e("SionPush", "SSE error: ${e.message}")
                if (!shouldRun) return
                try { Thread.sleep(5000) } catch (_: InterruptedException) { return }
            }
        }
    }

    private fun handleSseMessage(data: String) {
        try {
            // Parse ntfy JSON wrapper
            val ntfyMsg = org.json.JSONObject(data)
            val event = ntfyMsg.optString("event", "")
            if (event != "message") return

            val message = ntfyMsg.optString("message", "")
            if (message.isEmpty()) return

            android.util.Log.i("SionPush", "Real push received: ${message.take(100)}")

            // Parse Matrix push payload inside the message
            val pushPayload = org.json.JSONObject(message)
            val notification = pushPayload.optJSONObject("notification") ?: return
            val roomId = notification.optString("room_id", "")
            val eventId = notification.optString("event_id", "")
            val unread = notification.optJSONObject("counts")?.optInt("unread", 0) ?: 0

            val foreground = isAppInForeground()
            android.util.Log.i("SionPush", "roomId=$roomId unread=$unread foreground=$foreground")

            if (foreground) return

            showMessageNotification(roomId, eventId, unread)
        } catch (_: Exception) {
            // Ignore parse errors
        }
    }

    private fun isAppInForeground(): Boolean {
        val activityManager = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val appProcesses = activityManager.runningAppProcesses ?: return false
        for (process in appProcesses) {
            if (process.processName == packageName &&
                process.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
                return true
            }
        }
        return false
    }

    private fun showMessageNotification(roomId: String, eventId: String, unread: Int) {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("open_room_id", roomId)
                putExtra("open_event_id", eventId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Load room name from shared preferences if available
        val prefs = getSharedPreferences("sion_rooms", Context.MODE_PRIVATE)
        val roomName = prefs.getString(roomId, null)

        val title = "Sion"
        val body = if (roomName != null) {
            if (unread > 1) "$roomName — $unread nouveaux messages" else "$roomName — Nouveau message"
        } else {
            if (unread > 1) "$unread nouveaux messages" else "Nouveau message"
        }

        notificationCounter++
        val notifId = 3000 + (roomId.hashCode() and 0xFFFF)

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setNumber(unread)
            .build()

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(notifId, notification)
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)

            // Channel for push messages
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Messages",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Notifications de nouveaux messages"
                }
            )

            // Channel for the listener foreground notification (silent)
            manager.createNotificationChannel(
                NotificationChannel(
                    FOREGROUND_CHANNEL_ID,
                    "Service d'écoute",
                    NotificationManager.IMPORTANCE_MIN
                ).apply {
                    description = "Maintient la connexion pour recevoir les messages"
                    setShowBadge(false)
                }
            )
        }
    }
}
