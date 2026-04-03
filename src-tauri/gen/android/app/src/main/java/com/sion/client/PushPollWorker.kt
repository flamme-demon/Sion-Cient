package com.sion.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL

/**
 * Periodic worker that polls ntfy for new push notifications.
 * Uses WorkManager which survives app kill and battery optimization.
 */
class PushPollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    companion object {
        const val CHANNEL_ID = "sion_push_messages"
        private const val PREF_LAST_ID = "last_push_id"
    }

    override fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
        val topicUrl = prefs.getString("topic_url", null) ?: return Result.success()
        val lastId = prefs.getString(PREF_LAST_ID, null)

        // Use local ntfy URL to avoid NAT hairpinning
        val localTopicUrl = topicUrl.replace("https://push.sionchat.fr", "http://192.168.252.245:8090")

        try {
            val pollUrl = if (lastId != null) {
                "$localTopicUrl/json?poll=1&since=$lastId"
            } else {
                "$localTopicUrl/json?poll=1&since=30s"
            }

            val conn = URL(pollUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000

            if (conn.responseCode != 200) return Result.retry()

            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()

            if (body.isBlank()) return Result.success()

            var newLastId: String? = null

            for (line in body.lines()) {
                if (line.isBlank()) continue
                try {
                    val ntfyMsg = org.json.JSONObject(line)
                    val event = ntfyMsg.optString("event", "")
                    val id = ntfyMsg.optString("id", "")
                    if (event != "message") continue
                    if (id.isNotEmpty()) newLastId = id

                    val message = ntfyMsg.optString("message", "")
                    if (message.isEmpty()) continue

                    val pushPayload = org.json.JSONObject(message)
                    val notification = pushPayload.optJSONObject("notification") ?: continue
                    val roomId = notification.optString("room_id", "")
                    val unread = notification.optJSONObject("counts")?.optInt("unread", 0) ?: 0

                    // Check if app is in foreground
                    val am = applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
                    val foreground = am.runningAppProcesses?.any {
                        it.processName == applicationContext.packageName &&
                        it.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                    } ?: false

                    if (!foreground) {
                        showNotification(roomId, unread)
                    }
                } catch (_: Exception) { }
            }

            if (newLastId != null) {
                prefs.edit().putString(PREF_LAST_ID, newLastId).apply()
            }

        } catch (e: Exception) {
            android.util.Log.e("SionPush", "Poll error: ${e.message}")
            return Result.retry()
        }

        return Result.success()
    }

    private fun showNotification(roomId: String, unread: Int) {
        createChannel()

        val roomPrefs = applicationContext.getSharedPreferences("sion_rooms", Context.MODE_PRIVATE)
        val roomName = roomPrefs.getString(roomId, null)

        val title = "Sion"
        val body = if (roomName != null) {
            if (unread > 1) "$roomName — $unread nouveaux messages" else "$roomName — Nouveau message"
        } else {
            if (unread > 1) "$unread nouveaux messages" else "Nouveau message"
        }

        val openIntent = PendingIntent.getActivity(
            applicationContext, 0,
            Intent(applicationContext, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("open_room_id", roomId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notifId = 3000 + (roomId.hashCode() and 0xFFFF)
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setNumber(unread)
            .build()

        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.notify(notifId, notification)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = applicationContext.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "Notifications de nouveaux messages"
                    }
                )
            }
        }
    }
}
