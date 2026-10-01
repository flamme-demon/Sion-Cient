package com.sion.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Avis de messages reçus de ntfy, par l'écoute continue
 * (`NtfyListenerService`) comme par la relève périodique (`PushPollWorker`).
 *
 * Les deux avaient chacun leur traitement et leur mémoire : la relève
 * reprenait depuis SON dernier avis, et réaffichait toutes les 15 minutes ce
 * que l'écoute avait déjà montré (ou que l'on avait déjà balayé). Ici, un avis
 * n'est traité qu'une fois, et le dernier vu sert aux deux pour reprendre
 * après une coupure (`since=`).
 */
object PushRecus {
    const val CANAL = "sion_push_messages"
    private const val TAG = "SionPush"
    private const val PREFS = "sion_push"
    private const val DERNIER = "last_push_id"
    private const val COMPTE = "sion_compte"
    private const val PREMIER_ID = 3000

    /** Au-delà, un avis rattrapé après une longue coupure n'a plus rien
     *  d'actuel : on le note comme vu, sans notifier. */
    private const val AVIS_PERIME_S = 3600L

    private val vus = LinkedHashSet<String>()

    /** Le sujet sans son secret, pour les journaux. */
    fun masque(url: String): String = url.replace(Regex("(sion_[0-9a-z]{4})[0-9a-z]+"), "$1…")

    /** Repère de reprise pour ntfy (`since=`) : le dernier avis traité, ou
     *  l'heure du début de l'écoute. */
    fun dernier(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(DERNIER, null)

    /** Nouveau sujet : rien de l'ancien ne vaut pour lui, on repart d'une
     *  minute avant maintenant (le pusher est déclaré juste avant l'écoute :
     *  un avis tombé entre les deux est rattrapé). */
    fun repartir(context: Context) {
        synchronized(this) { vus.clear() }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(DERNIER, (System.currentTimeMillis() / 1000 - 60).toString())
            .apply()
    }

    /** Déconnexion : plus de sujet, plus de repère. */
    fun oublier(context: Context) {
        synchronized(this) { vus.clear() }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(DERNIER).apply()
    }

    @Synchronized
    private fun premiereFois(context: Context, id: String): Boolean {
        if (id.isEmpty()) return true
        if (!vus.add(id)) return false
        while (vus.size > 256) vus.remove(vus.first())
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(DERNIER, id).apply()
        return true
    }

    /** Une ligne JSON de ntfy (événement SSE ou ligne de relève). */
    fun traiter(context: Context, json: String) {
        val avis = try { JSONObject(json) } catch (_: Exception) { return }
        if (avis.optString("event") != "message") return
        if (!premiereFois(context, avis.optString("id"))) return

        val notification = try {
            JSONObject(avis.optString("message")).optJSONObject("notification")
        } catch (_: Exception) { null } ?: return
        val salon = notification.optString("room_id")
        val evenement = notification.optString("event_id")
        val nonLus = notification.optJSONObject("counts")?.optInt("unread", -1) ?: -1

        // Sans événement : le serveur ne fait que mettre à jour le compteur
        // (messages lus sur un autre appareil). Tout est lu : on efface.
        if (salon.isEmpty() || evenement.isEmpty()) {
            android.util.Log.i(TAG, "avis de compteur : non lus=$nonLus")
            if (nonLus == 0) effacer(context)
            return
        }

        // Interface vivante : elle notifie elle-même, avec le texte
        // déchiffré — pas de doublon.
        val vivante = MainActivity.vivante || auPremierPlan(context)
        val temps = avis.optLong("time", 0)
        val age = if (temps > 0) System.currentTimeMillis() / 1000 - temps else 0
        android.util.Log.i(TAG, "avis : salon=$salon vivante=$vivante âge=${age}s")
        if (vivante || age > AVIS_PERIME_S) return

        val mode = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("notification_mode", "all") ?: "all"
        val mp = context.getSharedPreferences("sion_rooms", Context.MODE_PRIVATE)
            .getString("${salon}_dm", null) == "true"
        // Chiffré, l'avis ne dit pas s'il nous mentionne : hors « all »,
        // seuls les messages privés passent.
        if (mode != "all" && !mp) return

        afficher(context, salon, evenement)
    }

    private fun auPremierPlan(context: Context): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        return am.runningAppProcesses?.any {
            it.processName == context.packageName &&
                it.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        } ?: false
    }

    private fun idNotification(salon: String) = PREMIER_ID + (salon.hashCode() and 0xFFFF)

    private fun afficher(context: Context, salon: String, evenement: String) {
        creerCanal(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        val id = idNotification(salon)

        // Compté sur la notification encore affichée : balayée, on repart
        // de un. (`counts.unread` du serveur est le total de TOUS les
        // salons, pas celui-ci.)
        val deja = manager.activeNotifications.firstOrNull { it.id == id }
            ?.notification?.extras?.getInt(COMPTE, 0) ?: 0
        val compte = deja + 1

        // Une intention par salon (code de requête = id) : avec un code
        // commun, toucher une notification ouvrait le salon de la DERNIÈRE.
        val ouvrir = PendingIntent.getActivity(
            context, id,
            Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("open_room_id", salon)
                putExtra("open_event_id", evenement)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val nom = context.getSharedPreferences("sion_rooms", Context.MODE_PRIVATE).getString(salon, null)
        val notification = NotificationCompat.Builder(context, CANAL)
            .setContentTitle(nom ?: "Sion")
            .setContentText(if (compte > 1) "$compte nouveaux messages" else "Nouveau message")
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setContentIntent(ouvrir)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setNumber(compte)
            .addExtras(Bundle().apply { putInt(COMPTE, compte) })
            .build()
        manager.notify(id, notification)
    }

    /** Retire les notifications de messages posées ici. */
    fun effacer(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (n in manager.activeNotifications) {
            if (n.notification.extras?.containsKey(COMPTE) == true) manager.cancel(n.id)
        }
    }

    fun creerCanal(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CANAL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Notifications de nouveaux messages"
            }
        )
    }
}
