# Voix native — lot session et périphériques

Le moteur LiveKit Rust (`--features native-voice`, désormais par défaut) est
le seul moteur vocal : la webview n'embarque plus `livekit-client`, le
sélecteur JS/Rust et tous les anciens chemins audio JS ont été retirés. La
fenêtre tourne sous WRY (WebKitGTK sous Linux, WebView2 sous Windows) : CEF,
`tauri-runtime-cef`, les correctifs vendored et les shims Chromium ont été
supprimés.

## Fonctions retirées, à porter en Rust

- **Mute local d'un participant** (menu contextuel) : le moteur Rust n'expose
  pas de gain par piste de voix. L'option a été retirée du menu.
- **Transcription de réunion** : portée sur un tap PCM natif (voir
  « Transcription native » ci-dessous) ; seule la voix Android reste à
  porter pour la rendre disponible partout.
- **RTT local** : l'ancien indicateur lisait le `rtt` du moteur JS. Le menu
  contextuel n'affiche plus que la qualité de connexion (fournie par Rust).
- **Voix Android** : `build-android.sh` ne compile pas `native-voice`
  (patch crates-io retiré), la voix Android passait par LiveKit JS. Elle est
  donc inactive tant que le moteur Rust n'est pas porté sur Android.

## Changements

- Détection de la feature compilée via `voice_native_available`.
- Abonnements installés avant la connexion ; une seule session suivie pour
  toutes les instances du hook. Sortie pendant une connexion, échec partiel,
  reconnexion et déconnexion définitive disposent d'un nettoyage commun.
- Les événements des anciens moteurs ne modifient plus le salon suivant.
- Micro et sortie sélectionnés parmi les GUID du SDK Rust, avec identifiant
  d'index de secours quand l'ADM Linux renvoie un GUID vide, et préférences
  distinctes des identifiants navigateur. Application au join et changement
  pendant l'appel. Un périphérique mémorisé absent au join utilise le défaut
  du SDK ; un changement manuel vers un périphérique absent est refusé.
- Liste native actualisée toutes les trois secondes quand ses réglages sont
  affichés. Cette actualisation ne reroute pas automatiquement un appel.
- Les contrôles AEC/AGC/RNNoise et son intensité s'appliquent au moteur natif,
  au join et pendant l'appel.
- Le vumètre des réglages lit le RMS du véritable APM WebRTC. Hors appel, il
  démarre un ADM temporaire sur le microphone choisi ; en appel, il réutilise
  la capture existante et n'ouvre pas un second microphone. La fermeture du
  panneau libère la capture de test hors appel.
- Le test haut-parleur joue trois notes par le contrôleur de rendu WebRTC sur
  la sortie native choisie. Les profils Voix/Voix HD/Musique règlent le débit
  Opus à 24/48/128 kbit/s dès le join et republient le micro à chaud.
- L'alerte « parler en étant muet » lit elle aussi le RMS natif. Tant que
  l'alerte ou les réglages en ont besoin, l'ADM continue de capturer localement
  après la dépublication du micro ; aucune piste n'est envoyée au salon.
- Le curseur de volume du son d'un partage est disponible en mode natif. Son
  gain 0–100 % est appliqué à la source distante WebRTC et survit aux
  désabonnements temporaires (mute/deafen) et republications.
- Les choix 720p/1080p/1440p et 5/15/30/60 i/s pilotent maintenant la mise à
  l'échelle de la capture et les limites d'encodage LiveKit natives. L'alerte
  « sans son » repose sur la présence réelle de la piste système publiée.
- Les images des partages reçus ne traversent plus les événements Tauri en
  JSON/base64. Un WebSocket local binaire conserve au plus la dernière image
  JPEG de chaque expéditeur et le front la peint hors React dans un canvas.
  Un viewer lent perd des images intermédiaires au lieu d'accumuler du retard.
- Sur Linux, le son du partage est publié seulement si le sink virtuel Sion a
  pu être créé. Il n'existe plus de repli vers le monitor de la sortie par
  défaut, qui aurait aussi capturé Sion et provoqué un écho. Sur Windows,
  l'échec du loopback par processus produit également un partage vidéo sans
  son plutôt qu'une capture globale.
- Le routage Linux associe chaque sink-input à ses ports avec l'identifiant
  PipeWire `node.id`. Les noms partagés comme « Chromium » ou « Firefox » ne
  peuvent plus provoquer la capture accidentelle d'un port appartenant à Sion.
- Les données de curseur reçues atteignent directement l'overlay Rust, sans
  aller-retour Rust → Tauri → JavaScript → Tauri → Rust. L'overlay peint la
  dernière position sans lissage supplémentaire avant sa capture.

## Validation manuelle à effectuer sur Linux et Windows

1. Rejoindre un salon contenant déjà des participants silencieux : la liste
   doit apparaître sans attendre un changement de parole ou de publication.
2. Interrompre brièvement le réseau, puis le rétablir : l'interface doit suivre
   la reconnexion. Une déconnexion définitive doit libérer salon et présence.
3. Quitter pendant une connexion lente, puis rejoindre : aucun micro, timer,
   overlay ou événement de l'ancienne session ne doit subsister.
4. Choisir micro et casque avant le join, puis les changer en appel ; vérifier
   auprès d'un pair les périphériques réellement utilisés. Répéter micro muté
   et casque en sourdine : aucune transmission ne doit reprendre implicitement.
   Hors appel, ouvrir les réglages Audio : le vumètre doit suivre le micro
   sélectionné et la mélodie doit sortir du haut-parleur sélectionné.
5. Débrancher un périphérique : la liste se met à jour. Vérifier le retour au
   défaut à la prochaine connexion, puis le choix du périphérique rebranché.
6. Salon chiffré : valider le pont E2EE MatrixRTC → Rust sur un aller-retour
   entre deux clients natifs (l'ancien test croisé avec un client JS n'est
   plus possible).
7. Regarder un partage déjà actif avant l'ouverture de la vue, y compris un
   écran immobile : sa première image doit apparaître. Bouger rapidement une
   fenêtre puis l'arrêter ; l'affichage doit rester net et rattraper la frame
   la plus récente sans lecture accélérée d'un backlog.
8. Partager avec le son et faire parler Sion/Picsou pendant qu'un média joue.
   Le média doit être reçu, mais aucune voix rendue par Sion ne doit revenir
   dans la piste de partage. Si l'exclusion système échoue, le front doit
   annoncer « sans son » et continuer la vidéo.

Les tests automatisés ne remplacent pas ces essais matériels et SFU.

### Résultat du test Linux du 9 septembre 2026

- Le passage HyperX → C920 déplace bien le `source-output` PipeWire vers la
  source 119 et publie un nouveau SID LiveKit. Le compteur APM continue
  d'avancer après le changement.
- La C920 testée renvoie cependant uniquement des zéros : 294 912 échantillons
  via PipeWire, puis 504 000 échantillons via ALSA `hw:1,0`, tous nuls. Le test
  microphone de KDE est également silencieux. Cette entrée ne permet donc pas
  de valider l'audibilité distante tant que son problème système ou matériel
  n'est pas résolu.
- Le retour au périphérique par défaut reroute et republie immédiatement le
  microphone HyperX.

## Traitement audio natif

RNNoise est maintenant intégré au post-traitement de capture WebRTC via le port
Rust `nnnoiseless`. L'APM conserve la capture et la référence de lecture de
WebRTC pour l'anti-écho. Les préférences AEC/AGC sont appliquées au véritable
APM logiciel ; l'antibruit WebRTC est désactivé pour éviter le double filtrage.
Le mélange brut/filtré aligne les deux signaux sur une trame de 10 ms.

Le pont est une extension optionnelle de `vendor/webrtc-sys`, sous la feature
`sion-audio`, activée uniquement par `native-voice`. Voir
[les détails du traitement](../src-tauri/native-audio/README.md) et
[la liste des modifications au SDK](../src-tauri/vendor/webrtc-sys/SION_PATCH.md).

`voice_native_debug` expose `processing` : instances APM, AEC/AGC réellement
appliqués, état de l'antibruit WebRTC (attendu : false), RNNoise et intensité.
L'indicateur de parole local lit maintenant la télémétrie de cette capture ;
il n'ouvre plus un second microphone CPAL.

Vérifications supplémentaires en appel réel : changer chaque traitement pendant
la parole, essayer les intensités 0/50/100 %, puis mute/unmute, changement de
micro, partage avec son et reconnexion. Les préférences doivent rester actives.
Le changement de microphone redémarre l'ADM et republie une piste locale. Sur
Linux, le flux `recStream` WebRTC est déplacé explicitement vers la source
PipeWire choisie avant et après cette publication, car l'ADM peut annoncer un
succès tout en restant attaché à l'ancienne source. Le log `contrôle micro`
confirme ensuite que les trames APM continuent d'arriver. Vérifier que le nouvel
appareil alimente immédiatement l'indicateur de parole et les autres
participants, sans devoir quitter le salon.
Tester l'écho avec haut-parleurs et soundboard : pendant un appel natif, les
clips sont maintenant mixés avant l'analyse de rendu WebRTC et font donc partie
de la référence AEC. Vérifier sur chaque plateforme que la sortie choisie est
respectée, que plusieurs clips peuvent se chevaucher et qu'aucun son n'est joué
deux fois. Hors appel natif, la lecture Web Audio historique reste utilisée.

## Passage WRY (retrait de CEF)

CEF a été entièrement retiré : crates `cef`/`tauri-runtime-cef`, feature
`cef`, fork vendored, `cef-dist`, staging des libs et shims Chromium. La
fenêtre utilise WRY (WebKitGTK sous Linux, WebView2 sous Windows) et
`native-voice` est une feature par défaut.

### Points à re-tester sous WebKitGTK

- Lecture vidéo/audio : les codecs dépendent de GStreamer (`gst-libav` pour
  H.264). Le transcode WebM proactif de `Message.tsx` reste en place.
- Notifications : `notify-rust` 4.18 paniquait dans le runtime tokio de Tauri.
  Corrigé par le fork `vendor/notify-rust` (appel bloquant isolé sur un thread
  std) ; vérifier l'affichage et les actions (répondre/ouvrir).
- Autoplay : les flags Chromium (`--autoplay-policy`) ont disparu ; vérifier
  que sons de connexion et médias se lancent sans clic préalable.
- Raccourcis globaux F1/F3/F5/F7/F11/F12 : toujours interceptés par la
  webview ; le reste passe par le portail XDG ou le plugin.
- `navigator.keyboard.getLayoutMap` n'existe pas sous WebKitGTK : l'affichage
  des combos retombe sur le code physique, sans impact fonctionnel.
- Partage d'écran avec son : l'exclusion des flux Sion couvre désormais
  `WebKitWebProcess`/`WebKitNetworkProcess` en plus de `sion-client` (les
  sous-process CEF héritaient du nom du binaire, pas WebKit). À valider en
  conditions réelles : aucun son de Sion ne doit revenir dans la capture.
- La restauration manuelle de taille de fenêtre (contournement CEF) a été
  retirée : `tauri-plugin-window-state` gère la géométrie. Vérifier sous
  Wayland.
- Téléchargements : l'app utilise son propre `download_file` (Rust) et envoie
  les liens externes au navigateur — rien à faire côté WRY. Overlay curseurs :
  validé. (Pas de « chat détaché » : l'app n'a qu'une seule fenêtre, rien à
  tester.)

### Mesures locales (debug, 10/09/2026)

Protocole : binaire debug, Vite dev, mesure `/proc` (RSS + PSS) sur l'arbre
de processus `sion-client` (les processus sont identifiés par filiation, ce
qui exclut le serveur Vite). État : app lancée, auto-join vocal, **visionnage
d'un partage 2560×1072 (~23 im/s)**, 3-4 min après démarrage (mesure stable
entre 3 et 4 min).

| | Avant (CEF) | Après (WRY) |
|---|---|---|
| Processus | 11 | 3 principaux (+ helpers sandbox WebKit `bwrap`/`glycin-svg` éphémères) |
| RSS total | ~2121 Mo | ~1417-1436 Mo |
| PSS total (pages partagées déduites) | non mesuré | ~960-980 Mo |
| dont `sion-client` | — | 419 Mo RSS / 236 Mo PSS |
| dont `WebKitWebProcess` | — | 900-915 Mo RSS / 670-685 Mo PSS |
| dont `WebKitNetworkProcess` | — | 98-102 Mo RSS / 55-59 Mo PSS |
| Binaire debug | 604 Mo | 577 MiB (605 Mo décimaux) |

Le RSS additionne des pages partagées : les valeurs servent d'ordre de
grandeur, pas de mesure absolue. Le PSS est la métrique à suivre.

Point de vigilance : après ~4 min d'**émission** de partage local (1080p+,
~42 im/s), le RSS total est monté à ~2415 Mo (PSS ~1946 Mo, processus Rust
~1,3 Go) et n'est pas redescendu ensuite. Une partie est le haut niveau
d'eau des allocations WebRTC/libc, mais l'écart mérite un suivi (mesurer
avant/après arrêt du partage sur une session longue, surveiller `RssAnon`).

Bug repéré dans les logs au même moment : à l'arrêt du partage, la
renégociation SDP échoue répétitivement avec
`A BUNDLE group contains a codec collision between {payload_type: 111, opus,
minptime:10, useinbandfec:1} and {…, sprop-stereo:1, useinbandfec:1}` →
`INVALID_PARAMETER`. L'ancien chemin Chromium contournait déjà ce point en
capturant le son du partage en mono (voir `system_audio.rs`) ; le chemin
natif reste exposé. À corriger côté paramètres Opus du micro (l'ADM publie
peut-être en stéréo) ou en alignant l'`AudioEncoding` sur celle du son de
partage.

### Transcription native (tap post-APM)

- `native-audio::transcription_tap` : le post-traitement APM (thread de
  capture) pousse la voie 0 en 16 kHz mono f32 normalisé, sans jamais bloquer
  l'audio (`try_lock` + canal borné ; une trame perdue vaut mieux qu'un
  glitch). Le taux d'entrée est déduit de la longueur de trame (160/320/480
  échantillons = 16/32/48 kHz).
- `transcribe.rs` : `transcribe_start_native(model, lang, mic_enabled)`
  abonne un segmenter global au tap (VAD + Whisper/Parakeet). `voice_engine`
  notifie chaque mute/unmute/sourdine via `note_native_mic_enabled` : le tap
  est coupé dans le callback et le segment en cours fermé — l'audio muet
  n'atteint jamais le modèle.
- Front : plus d'AudioWorklet ni de PCM sur le WebSocket ; il ne sert plus
  qu'à recevoir `ready`/`segment`, publiés dans Matrix. L'intention « armé »
  passe par le data packet `sion-transcribe-arm` (même consentement : session
  démarrée à ≥2 armés, n'importe qui peut la clore).
- Test E2E local (modèle Parakeet + `espeak-ng` + ffmpeg) :
  `SION_TEST_ASR_MODEL=<gguf> SION_TEST_ASR_PCM=<f32le 48 kHz> cargo test --offline --features native-voice --lib native_tap_end_to_end -- --ignored --nocapture`
  — validé le 10/09 (segment FR transcrit correctement).

### Drag & drop et presse-papiers sous WRY

Deux régressions du passage à WebKitGTK, corrigées :

- **Fichiers déposés** : WebKitGTK ne transmet pas les fichiers du gestionnaire
  de fichiers au DOM (Tauri intercepte le drop natif et n'expose que des
  chemins). On utilise les événements `getCurrentWebview().onDragDropEvent`
  + la commande `read_dropped_file` (IPC binaire, plafond 512 Mo) qui
  reconstruit un `File` avec un type MIME deviné depuis l'extension
  (`src/utils/droppedFile.ts`, câblage dans `MainArea.tsx`).
- **Ctrl+V image** : WebKitGTK n'expose pas les images dans
  `ClipboardEvent.clipboardData.items`. Commande `read_clipboard_image` :
  lecture brute via `wl-clipboard-rs` (protocole Wayland data-control) des
  octets **d'origine** (PNG/JPEG/WebP/GIF) — aucun décodage, aucun
  redimensionnement, donc taille réelle et latence minimale. Repli `arboard`
  (RGBA→PNG, sans resize) si aucune image encodée n'est exposée ; feature
  `wayland-data-control` activée. `src/utils/clipboardImage.ts` détecte le
  type par signature et construit le `File`.

### Nettoyage des restes de l'ancien moteur

- `system_audio` n'expose plus de serveur WebSocket ni de commandes IPC : les
  frames PCM passent par un canal mpsc interne (`system_audio_subscribe`)
  drainé par `voice_engine::run_share_audio_pump`. `system_audio_start` et
  `stop` ne sont plus des commandes Tauri (appelées directement en Rust).
- Commandes Tauri mortes supprimées : `list_audio_devices`,
  `switch_audio_device`, `set_default_audio`, `get_default_audio_devices`,
  `poll_shortcuts`, `start_voice_service`/`stop_voice_service`,
  `cursor_overlay_push*` (appelés directement en Rust), `system_audio_ws_port`
  et `system_audio_list_sinks` (le sélecteur de moniteur n'existe plus :
  l'engine demande toujours `None`).
- macOS : le son du partage n'est plus capturé (l'ancien chemin passait par
  `getDisplayMedia({ systemAudio })` de Chromium) — partage sans son, à
  implémenter côté natif si besoin.
- Binaire : `cargo tree -i cef` vide, aucune liaison `libcef.so`, aucun
  symbole CEF (les entrées `cef` du `Cargo.lock` sont des dépendances
  optionnelles du crate `tauri` git, non compilées). Artefacts CEF obsolètes
  purgés de `target/debug` (`libcef.so` 1,3 Go + 310 objets, ~10 Go).

### Partage d'écran sous WRY — correctifs

Trois bugs enchaînés, tous côté Rust :

1. **Gel de l'UI pendant la sélection** : `voice_native_set_screensharing`
   attendait la première image (jusqu'à 60 s) en gardant le moteur hors du
   holder. Le mutex global restait donc pris, et toutes les commandes vocales
   synchrones (publis de curseur à 60 Hz, mute…) bloquaient le thread
   principal. La piste est maintenant publiée immédiatement ; une panne du
   portail remonte via `voice-native-local-share-failed` et dépublie.
2. **Aucune frame malgré le sélecteur KDE** : le portail délivre ses réponses
   D-Bus sur le contexte GLib thread-default. La feature `glib-main-loop` de
   `libwebrtc` utilisait le contexte global, possédé par GTK sous WRY : les
   callbacks n'étaient jamais dispatchés. Patch vendored
   (`vendor/libwebrtc/SION_PATCH.md`) : contexte `MainContext` privé poussé en
   thread-default le temps de créer le proxy du portail, puis itéré sur son
   thread.
3. **Use-after-free à l'abandon** : si la capture est abandonnée avant
   publication, le capturer n'est plus détruit pendant que le portail peut
   encore rappeler dessus.

### Mute/deafen sans renégociation (stabilité clients prod)

Le moteur natif dépubliait/republiait la piste micro à chaque F8/F9 : chaque
bascule provoquait une renégociation SDP complète, et un enchaînement rapide
faisait décrocher les clients de production. La piste est désormais conservée
et basculée avec `track.mute()` / `track.unmute()` (parité `livekit-client`) :
plus aucune renégociation. Le republish n'a lieu qu'en cas de changement de
périphérique ou de débit pendant le mute (`mic_needs_republish`). Côté front,
les bascules moteur mute/deafen sont sérialisées (une file unique) pour éviter
les commandes concurrentes.

Piège SDK : `track.mute()/unmute()` notifie la room via une tâche tokio — sans
contexte runtime (`self.rt.enter()`, comme `set_deafened`), le SDK panique
« there is no reactor running », la panique est isolée par `catch_unwind`
mais **le mute n'est pas appliqué** (constaté dans les logs du 11/09). Les
trois appels (mute, unmute, mute-au-publish) entrent désormais le contexte.

**Corrigé** : le SFU LiveKit envoyait `sprop-stereo=1` sur une seule m-line
opus (piste stéréo) avec le même PT 111 que les m-lines mono → libwebrtc
rejetait le BUNDLE (`codec collision`, `INVALID_PARAMETER`) à la connexion et
à chaque renégociation. Le crate `libwebrtc` vendored normalise désormais la
description distante (toutes les m-lines opus reçoivent le même fmtp) avant
de l'appliquer — voir `vendor/libwebrtc/SION_PATCH.md`.
