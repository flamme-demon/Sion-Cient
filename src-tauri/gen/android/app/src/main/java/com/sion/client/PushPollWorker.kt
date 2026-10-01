package com.sion.client

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL

/**
 * Relève périodique du sujet ntfy (WorkManager, toutes les 15 minutes) : le
 * filet de l'écoute continue, quand Android l'a arrêtée. Elle reprend depuis
 * le dernier avis traité, par l'un ou par l'autre (`PushRecus`).
 */
class PushPollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val topicUrl = applicationContext.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
            .getString("topic_url", null) ?: return Result.success()

        // L'écoute continue a disparu (processus tué) : on la relance,
        // quand Android permet de démarrer un service de premier plan
        // depuis l'arrière-plan (appli exemptée d'optimisation de batterie).
        if (!NtfyListenerService.isRunning) {
            try {
                NtfyListenerService.start(applicationContext, topicUrl)
            } catch (e: Exception) {
                android.util.Log.w("SionPush", "relève : écoute non relancée (${e.javaClass.simpleName})")
            }
        }

        val depuis = PushRecus.dernier(applicationContext) ?: "30s"
        try {
            val conn = URL("$topicUrl/json?poll=1&since=$depuis").openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            try {
                if (conn.responseCode != 200) return Result.retry()
                conn.inputStream.bufferedReader().useLines { lignes ->
                    for (ligne in lignes) {
                        if (ligne.isNotBlank()) PushRecus.traiter(applicationContext, ligne)
                    }
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            android.util.Log.w("SionPush", "relève : ${e.javaClass.simpleName}: ${e.message}")
            return Result.retry()
        }
        return Result.success()
    }
}
