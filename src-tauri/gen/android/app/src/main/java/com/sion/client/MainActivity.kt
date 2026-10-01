package com.sion.client

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

class MainActivity : TauriActivity() {

  companion object {
    /** Interface vivante (WebView créé) : c'est elle qui notifie, avec le
     *  texte déchiffré ; le service ntfy ne prend le relais que sans elle. */
    @Volatile var vivante = false
    private const val DEMANDE_NOTIFICATIONS = 4243
  }

  private var voiceActionReceiver: BroadcastReceiver? = null
  private var cachedWebView: WebView? = null
  /** Appels à rejouer dans la page dès qu'elle est prête (toucher d'une
   *  notification, réponse tapée dedans). */
  private val enAttente = ArrayList<String>()
  private var rejeuEnCours = false

  // Le pont `__SION__` doit être posé AVANT le chargement de la page : un
  // objet ajouté ensuite n'apparaît qu'au chargement suivant. Posé par un
  // `post` qui cherchait le WebView, il arrivait trop tard dans la version
  // de publication (plus rapide que celle de dev) : plus de contrôle du
  // micro — entrée en vocal sans autorisation, plantage de libwebrtc — ni de
  // push, pour toute la session (beta 4, 30/09). wry appelle ce crochet à la
  // création du WebView, avant de charger la page.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    cachedWebView = webView
    webView.addJavascriptInterface(VoiceServiceBridge(this), "__SION__")
    webView.settings.mediaPlaybackRequiresUserGesture = false
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Avant Tauri : le moteur Matrix fait ses premières requêtes dès le
    // démarrage, et la voix a besoin de WebRTC côté Java.
    SionNatif.initialiser(applicationContext)
    // Avant Tauri aussi : son module de notifications lit l'intention au
    // chargement, quand la page n'écoute pas encore.
    if (savedInstanceState == null) reprendreNotificationInterface(intent)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    vivante = true
    // Android 13+ : sans cette autorisation, aucune notification — ni
    // message, ni appel en cours (29/09 : jamais demandée).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), DEMANDE_NOTIFICATIONS)
    }

    // Navigation demandée par une notification, une fois le WebView là
    // (le pont `__SION__`, lui, est posé dans `onWebViewCreate`).
    window.decorView.post(object : Runnable {
      override fun run() {
        val webView = cachedWebView ?: findWebView()
        if (webView != null) {
          cachedWebView = webView
          rejouer()
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
          VoiceCallService.ACTION_APPEL_DEBUT -> "appel-debut"
          VoiceCallService.ACTION_APPEL_FIN -> "appel-fin"
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

  // Plus de court-circuit de onPause/onStop pendant un appel : il gardait le
  // WebView éveillé pour la voix JS (1.x). La voix vit désormais en Rust,
  // tenue par le service d'appel ; ce contournement (réflexion, reprise
  // forcée du WebView pendant l'arrêt) coïncidait avec des plantages du
  // WebView à l'extinction de l'écran en plein appel (29/09).

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == VoiceServiceBridge.DEMANDE_MICRO) {
      val accordee = grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
      VoiceServiceBridge.reponseMicro = if (accordee) "accordée" else "refusée"
    }
  }

  override fun onResume() {
    super.onResume()
    // Clear push notifications when app comes to foreground
    val manager = getSystemService(NotificationManager::class.java)
    for (notification in manager.activeNotifications) {
      if (notification.id >= 3000) {
        manager.cancel(notification.id)
      }
    }
    // Handle notification tap — navigate to room
    handleNotificationIntent(getIntent())
  }

  override fun onNewIntent(intent: Intent) {
    reprendreNotificationInterface(intent)
    super.onNewIntent(intent)
    setIntent(intent)
    handleNotificationIntent(intent)
  }

  /** Relancé depuis les applis récentes, Android redonne l'intention
   *  d'origine, extras compris : une notification déjà traitée (une réponse
   *  déjà envoyée !) ne doit pas l'être une seconde fois. */
  private fun depuisRecentes(intent: Intent) =
    intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0

  private fun handleNotificationIntent(intent: Intent?) {
    if (intent == null || depuisRecentes(intent)) return
    val roomId = intent.getStringExtra("open_room_id") ?: return
    android.util.Log.i("SionPush", "handleNotificationIntent: roomId=$roomId")
    intent.removeExtra("open_room_id")
    // Jusqu'au message lui-même, pas seulement le salon.
    val eventId = intent.getStringExtra("open_event_id")
    intent.removeExtra("open_event_id")

    // Clear all message notifications
    val manager = getSystemService(NotificationManager::class.java)
    manager.cancelAll()

    appelerPage("window.__SION_OPEN_ROOM__(${JSONObject.quote(roomId)}, ${eventId?.let { JSONObject.quote(it) } ?: "undefined"})")
  }

  /**
   * Notification posée par l'interface (`tauri-plugin-notification`),
   * touchée ou répondue. Le module la transmet à la page par un événement,
   * sans le garder : appli fermée, la page n'écoutait pas encore, et le
   * toucher n'ouvrait rien — une réponse tapée dans la notification se
   * perdait. Lue ici, retirée de l'intention pour que le module ne la
   * transmette pas en double, puis rejouée dans la page une fois prête.
   */
  private fun reprendreNotificationInterface(intent: Intent?) {
    if (intent == null || depuisRecentes(intent)) return
    val id = intent.getIntExtra("NotificationId", Int.MIN_VALUE)
    if (id == Int.MIN_VALUE) return
    val action = intent.getStringExtra("NotificationUserAction")
    val texte = androidx.core.app.RemoteInput.getResultsFromIntent(intent)
      ?.getCharSequence("NotificationRemoteInput")?.toString()?.trim()
    val extra = try {
      JSONObject(intent.getStringExtra("LocalNotficationObject") ?: "{}").optJSONObject("extra")
    } catch (_: Exception) { null }
    intent.removeExtra("NotificationId")
    intent.removeExtra("NotificationUserAction")
    intent.removeExtra("LocalNotficationObject")
    androidx.core.app.NotificationManagerCompat.from(this).cancel(id)

    val salon = extra?.optString("roomId").orEmpty()
    if (salon.isEmpty()) return
    val evenement = extra?.optString("eventId").orEmpty()
    android.util.Log.i("SionPush", "notification de l'interface : action=$action salon=$salon")
    val q = JSONObject::quote
    if (action == "reply") {
      if (!texte.isNullOrEmpty()) appelerPage("window.__SION_REPONDRE__(${q(salon)}, ${q(evenement)}, ${q(texte)})")
    } else {
      appelerPage("window.__SION_OPEN_ROOM__(${q(salon)}, ${q(evenement)})")
    }
  }

  /** Rejoue `appel` dans la page dès que ses points d'entrée existent. */
  private fun appelerPage(appel: String) {
    enAttente.add(appel)
    rejouer()
  }

  private fun rejouer() {
    val webView = cachedWebView ?: return
    if (rejeuEnCours || enAttente.isEmpty()) return
    rejeuEnCours = true
    var attempts = 0
    val poller = object : Runnable {
      override fun run() {
        attempts++
        webView.evaluateJavascript(
          "typeof window.__SION_OPEN_ROOM__ === 'function' && typeof window.__SION_REPONDRE__ === 'function' ? 'ready' : 'no'"
        ) { result ->
          if (result.contains("ready")) {
            android.util.Log.i("SionPush", "page prête : ${enAttente.size} appel(s) rejoué(s)")
            for (appel in enAttente) webView.evaluateJavascript(appel, null)
            enAttente.clear()
            rejeuEnCours = false
          } else if (attempts < 60) {
            webView.postDelayed(this, 1000)
          } else {
            android.util.Log.w("SionPush", "page jamais prête : ${enAttente.size} appel(s) abandonné(s)")
            enAttente.clear()
            rejeuEnCours = false
          }
        }
      }
    }
    webView.post(poller)
  }

  override fun onDestroy() {
    vivante = false
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
