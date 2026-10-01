package com.sion.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.net.HttpURLConnection
import java.net.URL

/**
 * Écoute continue du sujet ntfy de l'appareil (SSE) : chaque avis de message
 * passe à `PushRecus`, qui notifie si l'interface n'est pas là.
 */
class NtfyListenerService : Service() {

    companion object {
        const val FOREGROUND_CHANNEL_ID = "sion_push_listener"
        const val NOTIFICATION_ID = 2001
        const val EXTRA_TOPIC_URL = "topic_url"
        private const val ATTENTE_MIN = 5_000L
        private const val ATTENTE_MAX = 120_000L

        var isRunning = false
            private set

        fun start(context: Context, topicUrl: String) {
            context.getSharedPreferences("sion_push", Context.MODE_PRIVATE)
                .edit().putString("topic_url", topicUrl).apply()
            val intent = Intent(context, NtfyListenerService::class.java).apply {
                putExtra(EXTRA_TOPIC_URL, topicUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            isRunning = false
            context.stopService(Intent(context, NtfyListenerService::class.java))
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var listenerThread: Thread? = null
    @Volatile private var shouldRun = true
    /** Sujet de l'écoute en cours. */
    private var sujetEcoute: String? = null
    /** Une écoute par génération : remplacée (nouveau sujet), l'ancienne
     *  s'arrête d'elle-même au lieu de lire en parallèle. */
    @Volatile private var generation = 0
    @Volatile private var connexion: HttpURLConnection? = null
    /** Réveil de l'attente entre deux connexions (réseau revenu, arrêt).
     *  Pas `Thread.interrupt()` : la pile HTTP d'Android consomme
     *  l'interruption, et l'attente durait quand même. */
    private val reveil = Object()
    private var reveille = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        isRunning = true

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sion:pushlistener").apply {
            acquire()
        }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(surveillanceReseau)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // MUST call startForeground within 5 seconds
        createNotificationChannels()
        val fgNotification = NotificationCompat.Builder(this, FOREGROUND_CHANNEL_ID)
            .setContentTitle("Sion")
            .setContentText("Connecté — en attente de messages")
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, fgNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, fgNotification)
        }

        val topicUrl = intent?.getStringExtra(EXTRA_TOPIC_URL)
            ?: getSharedPreferences("sion_push", Context.MODE_PRIVATE).getString("topic_url", null)
            ?: run {
                android.util.Log.w("SionPush", "No topic URL, stopping")
                stopSelf()
                return START_NOT_STICKY
            }
        getSharedPreferences("sion_push", Context.MODE_PRIVATE)
            .edit().putString("topic_url", topicUrl).apply()

        // L'interface redemande l'écoute à chaque lancement : même sujet,
        // la connexion en cours reste (avant : une seconde connexion
        // s'ouvrait, et l'ancienne lisait toujours).
        if (topicUrl == sujetEcoute && listenerThread?.isAlive == true) {
            android.util.Log.i("SionPush", "SSE : déjà à l'écoute de ${PushRecus.masque(topicUrl)}")
            return START_STICKY
        }
        sujetEcoute = topicUrl
        val gen = ++generation
        connexion?.disconnect()
        reveiller()
        listenerThread = Thread { ecouter(topicUrl, gen) }.apply {
            isDaemon = true
            start()
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // App was swiped — restart the service
        android.util.Log.i("SionPush", "Task removed, scheduling restart")
        val topicUrl = getSharedPreferences("sion_push", Context.MODE_PRIVATE)
            .getString("topic_url", null)
        if (topicUrl != null) {
            val restartIntent = Intent(this, NtfyListenerService::class.java).apply {
                putExtra(EXTRA_TOPIC_URL, topicUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(restartIntent)
            } else {
                startService(restartIntent)
            }
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        isRunning = false
        shouldRun = false
        generation++
        connexion?.disconnect()
        reveiller()
        listenerThread = null
        sujetEcoute = null
        try {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(surveillanceReseau)
        } catch (_: Exception) { }
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Réseau par défaut changé (Wi-Fi ↔ 4G, retour du réseau) : l'ancienne
     *  connexion est morte sans le savoir, on la remplace tout de suite au
     *  lieu d'attendre le délai de lecture ou la fin de l'attente. */
    private val surveillanceReseau = object : ConnectivityManager.NetworkCallback() {
        private var reseau: Network? = null
        private var premier = true

        override fun onAvailable(network: Network) {
            val change = reseau != network
            reseau = network
            if (premier) {
                premier = false
                return
            }
            if (change) {
                android.util.Log.i("SionPush", "SSE : réseau changé, reconnexion")
                connexion?.disconnect()
                reveiller()
            }
        }

        override fun onLost(network: Network) {
            if (reseau == network) reseau = null
        }
    }

    private fun ecouter(topicUrl: String, gen: Int) {
        var attente = ATTENTE_MIN
        while (shouldRun && gen == generation) {
            // Reprise après une coupure : ntfy renvoie d'abord ce qui est
            // arrivé depuis le dernier avis traité.
            val depuis = PushRecus.dernier(this)
            val adresse = if (depuis != null) "$topicUrl/sse?since=$depuis" else "$topicUrl/sse"
            android.util.Log.i("SionPush", "SSE : connexion à ${PushRecus.masque(topicUrl)}")
            var conn: HttpURLConnection? = null
            try {
                conn = URL(adresse).openConnection() as HttpURLConnection
                conn.setRequestProperty("Accept", "text/event-stream")
                conn.connectTimeout = 30_000
                // ntfy envoie un « keepalive » toutes les 45 s : rien pendant
                // 100 s, la connexion est morte (réseau changé, NAT oublié).
                // Sans délai (0), l'écoute pouvait rester bloquée sur une
                // connexion morte, sans plus jamais rien recevoir.
                conn.readTimeout = 100_000
                connexion = conn
                val code = conn.responseCode
                if (code != 200) throw java.io.IOException("réponse $code")
                android.util.Log.i("SionPush", "SSE : connecté")
                attente = ATTENTE_MIN
                conn.inputStream.bufferedReader().use { lecteur ->
                    while (shouldRun && gen == generation) {
                        val ligne = lecteur.readLine() ?: break
                        if (ligne.startsWith("data: ")) PushRecus.traiter(this, ligne.removePrefix("data: "))
                    }
                }
                if (gen == generation) android.util.Log.w("SionPush", "SSE : fermé par le serveur")
            } catch (e: Exception) {
                if (!shouldRun || gen != generation) return
                android.util.Log.w("SionPush", "SSE : coupé (${e.javaClass.simpleName}: ${e.message})")
            } finally {
                conn?.disconnect()
            }
            if (!shouldRun || gen != generation) return
            // Réseau revenu pendant la connexion ou l'attente : on retente
            // tout de suite, et sans délai accumulé.
            attente = if (attendre(attente)) ATTENTE_MIN else minOf(attente * 2, ATTENTE_MAX)
        }
    }

    private fun reveiller() {
        synchronized(reveil) {
            reveille = true
            reveil.notifyAll()
        }
    }

    /** Attend `ms` au plus ; vrai si réveillé avant. */
    private fun attendre(ms: Long): Boolean {
        synchronized(reveil) {
            if (!reveille) {
                try { reveil.wait(ms) } catch (_: InterruptedException) { }
            }
            val r = reveille
            reveille = false
            return r
        }
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            PushRecus.creerCanal(this)

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
