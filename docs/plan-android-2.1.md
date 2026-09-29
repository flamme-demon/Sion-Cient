# Plan Android 2.1 — remettre Sion sur téléphone

Document de travail du 28/09/2026. La 2.0.0 sort pour ordinateurs seulement
(décision du 24/09, `docs/roadmap-2.0.0.md` §6) ; ce plan décrit le retour
d'Android en 2.1 : architecture, design téléphone, fonctions gardées ou
retirées, build, publication, tests.

## 0. En bref

- **Le même cœur que l'ordinateur.** Moteur Matrix Rust (`sion-matrix`) et
  voix Rust (LiveKit Rust + libwebrtc Android) compilés pour Android ; plus de
  build « à part » où `build-android.sh` retire les deux features.
- **La même interface React**, dans le WebView Android (Chromium, plus rapide
  et moins piégeux que WebKitGTK), avec une **vraie mise en page téléphone** :
  onglets en bas, feuilles qui montent du bas, appui long au lieu du survol.
- **Pas de retour à `livekit-client` JS** : il a quitté `package.json` en 2.0,
  et la clé de chiffrement MatrixRTC vit désormais dans le cœur Rust.
- **Mise à jour en place de la 1.x** : même identifiant `com.sion.client`,
  même clé de signature, APK signé joint aux releases GitHub.
- **Le téléphone reste un téléphone** : tout le chat, la voix, le partage
  *reçu*, les notifications riches. Pas d'émission de partage d'écran, pas
  d'overlays, pas de modèles locaux (transcription, TTS).
- Sept étapes (A0 à A6). La voix (A2) est le gros morceau et le principal
  risque ; les notifications (A4) apportent le plus au quotidien.

## 1. État des lieux (vérifié dans le code le 28/09)

| Élément | État | Conséquence |
| --- | --- | --- |
| `build-android.sh` | remplace par `sed` `default = ["native-voice", "moteur-matrix-rust"]` par `default = []` le temps du build | Android tourne sur l'ancien moteur Matrix JS, sans voix |
| Voix Android | passait par `livekit-client` JS, retiré en 2.0 | un build 2.0 Android n'a **aucune voix** |
| `sion-matrix` | compile pour Android arm64 (vérifié à T0) ; secrets gardés dans le fichier de session (pas de trousseau) | le cœur est prêt, reste à l'activer |
| `vendor/webrtc-sys` | branche Android complète (`src/android.cpp`, sysroot NDK, `configure_jni_symbols`) ; ADM de la plateforme créé à la demande sur Android (`adm_proxy.cpp`) | la voix Rust est portable, il manque l'initialisation JNI et le `.jar` |
| `vendor/libwebrtc` | expose `android::initialize_android(vm)` et `initialize_android_context(vm, context)` | point d'entrée JNI déjà là |
| libwebrtc précompilé | téléchargé par `webrtc-sys-build` (tag `webrtc-89d790b`, archive `android-arm64`) | rien à compiler côté WebRTC |
| Modules bureau | `cursor_overlay`, `native_video_surface`, `pip_window`, `summarize`, `system_audio`, `transcribe`, `tts`, `incrustation_lecteur`, `meme_pop`, `profil` déjà exclus d'Android (`#[cfg(not(target_os = "android"))]`) | peu de ménage côté Rust |
| Partage reçu | `native_video_transport` (WebSocket local, JPEG) **non exclu** d'Android | le partage reçu peut s'afficher dans un `<canvas>` sans surface native |
| Kotlin (`gen/android/.../client/`) | `MainActivity` (pont `__SION__`), `VoiceCallService` (service de premier plan micro + lecture), `NtfyListenerService` (SSE ntfy), `PushPollWorker`, `PushRestartReceiver`, `VoiceServiceBridge` — ~1 000 lignes | à garder, à brancher sur la voix Rust, à remettre au propre |
| `MainActivity.onPause/onStop` | court-circuite par réflexion la mise en pause du WebView pendant un appel (la voix JS en dépendait) | **à supprimer** : la voix Rust ne dépend plus du JS |
| Filtrage des notifications push | côté Kotlin, sans déchiffrement (« Can't detect mentions in E2EE — only DMs pass ») | notifications pauvres (« Nouveau message ») |
| UI mobile | `useIsMobile` (< 768 px), `mobileView` = `sidebar` ou `chat`, `MobileVoiceBar.tsx`, ~10 composants adaptés | base utilisable, design à refaire |
| Version | `tauri.properties` : versionName 1.0.0, versionCode 1000000 ; minSdk 24, targetSdk 36 | schéma de versionCode à fixer (les bêtas) |
| Signature | `sion-release.keystore` à la racine (ignoré par git), `keystore.properties` optionnel | **vérifier que c'est la clé des APK 1.x** |
| Publication | aucun APK joint aux releases GitHub, pas de job CI Android | à créer |
| WebView | `onShowFileChooser` et `onPermissionRequest` gérés par wry 0.57 ; origine `http://tauri.localhost` (pas de `useHttpsScheme`) | pièces jointes OK ; **ne pas changer l'origine** (migration, voir A0) |

## 2. Architecture cible

```
Processus Android com.sion.client
├── MainActivity (WryActivity de Tauri)
│   └── WebView Chromium ── interface React (même code, mise en page téléphone)
│            │ invoke / événements Tauri
├── libsion_client.so (Rust)
│   ├── sion-matrix ── SQLite + magasin de chiffrement (dossier de l'appli)
│   ├── voice_native ── LiveKit Rust + libwebrtc (ADM Java via libwebrtc.jar)
│   ├── native_video_transport ── partage reçu → JPEG → WebSocket local
│   └── sion_android (nouveau) ── fonctions JNI appelées par Kotlin
└── Kotlin : plugin Tauri « sion-android » (remplace le pont `__SION__`)
    ├── VoiceCallService ── service de premier plan (micro), notification d'appel
    ├── RouteAudio ── AudioManager : écouteur / haut-parleur / Bluetooth / filaire
    ├── Notifications ── canaux, MessagingStyle, réponse directe, « lu »
    ├── Push ── NtfyListenerService + PushPollWorker (UnifiedPush plus tard)
    └── MiseAJour ── téléchargement + installation de l'APK
```

### Décisions

- **D1 — Voix : Rust natif, pas JS.** Une seule pile vocale pour tous les
  systèmes ; la distribution des clés MatrixRTC, le RNNoise
  (`nnnoiseless`, Rust pur), le mélangeur de soundboard et les réglages
  d'écho viennent avec. Revenir à `livekit-client` voudrait dire maintenir
  deux moteurs et deux chiffrements.
- **D2 — Interface : le code React existant**, pas une interface Kotlin/
  Compose séparée. Parité immédiate, un seul code ; le WebView Android est
  Chromium (H.264 natif, `document.hasFocus()` fiable, défilement ancré).
  Une interface native reste possible plus tard (même question que sur le
  bureau, `project_banc_ui_natif`), ce plan ne la ferme pas.
- **D3 — Initialisation JNI au démarrage**, avant toute fabrique WebRTC :
  `ndk_context::android_context()` donne la JavaVM et le Context →
  `libwebrtc::android::initialize_android_context(vm, context)`.
  `libwebrtc.jar` (dans l'archive précompilée) entre dans Gradle
  (`implementation(files("libs/libwebrtc.jar"))`), et ProGuard garde
  `org.webrtc.**`.
- **D4 — Plus de `sed` sur `Cargo.toml`.** `native-voice` et
  `moteur-matrix-rust` restent par défaut partout ; ce qui est propre au
  bureau reste derrière `cfg(not(target_os = "android"))` (déjà le cas pour
  presque tout). Le build Android devient `bun run tauri android build`
  sans retouche du dépôt.
- **D5 — Un plugin Tauri Android** au lieu de `addJavascriptInterface` :
  appels typés depuis Rust *et* depuis le JS (route audio, service d'appel,
  permissions), et Kotlin peut rappeler Rust par JNI quand le WebView dort
  (actions de notification).
- **D6 — Notifications : le push reste la source en arrière-plan.** Le
  WebView est mis en pause hors premier plan et Android gèle les processus en
  cache : les notifications calculées par `notificationsMessages.ts` ne
  suffisent pas. Le push (serveur → ntfy → Kotlin) réveille l'appli, Kotlin
  demande à Rust de déchiffrer l'événement, puis affiche une vraie
  notification. Dédoublonnage par identifiant d'événement.
- **D7 — Secrets.** Fichier de session dans le stockage privé de l'appli
  (état actuel), puis chiffré par une clé du **Android Keystore** (A5).

## 3. Design téléphone

### 3.1 Principes

- **Une main** : actions fréquentes en bas de l'écran ; cibles tactiles
  ≥ 48 dp ; rien qui n'existe qu'au survol.
- **Feuilles du bas** (bottom sheets) pour les menus, sélecteurs et panneaux
  (emojis, GIF, membres, épingles, soundboard) ; fermeture par glissement.
- **Retour Android** (geste ou bouton) : ferme la feuille ouverte → quitte la
  vue plein écran → revient à la liste → sort de l'appli. Une pile unique
  (`App.tsx` gère déjà `chat → sidebar`).
- **Bord à bord** : targetSdk 36 l'impose (Android 15+). Marges
  `env(safe-area-inset-*)` en haut (barre d'état) et en bas (barre de gestes).
- **Clavier** : la zone de saisie remonte avec le clavier
  (`interactive-widget=resizes-content` dans le viewport, `adjustResize`) ;
  le fil reste collé en bas quand on y était.
- **Thème** : sombre / clair / AMOLED existants, « suivre le système » par
  défaut ; fonds animés coupés par défaut (batterie).
- **Taille du texte** : respecter le réglage d'accessibilité du système.

### 3.2 Navigation

Trois onglets en bas, la barre d'appel flotte au-dessus quand on est en vocal.

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Sion                 🔍  ⋮  │   │ ←  # général      📌 👥 🔊 │
├──────────────────────────────┤   ├──────────────────────────────┤
│ SALONS TEXTE                 │   │  Narkow            17:31     │
│  # général            ●  3  │   │  t'es là ?                    │
│  # memes                     │   │ ───── Nouveaux messages ──── │
│ SALONS VOCAUX                │   │  Picsou            17:40     │
│  🔊 Chihuahuatistant         │   │  go vocal                     │
│     ◉ Picsou  ○ Narkow       │   │                          (↓●)│
│  🔊 AFK                      │   ├──────────────────────────────┤
├──────────────────────────────┤   │ ＋ │ Message #général   │😊│➤│
│ 🔊 Chihuahuatistant  🎙 🎧 ✕ │   └──────────────────────────────┘
├──────────────────────────────┤
│  💬 Salons   ✉ MP   👤 Moi  │
└──────────────────────────────┘
```

- **Salons** : salons texte (non-lus, pastille de mention) et vocaux avec
  leurs participants (anneau quand ils parlent, micro/casque coupés).
- **MP** : conversations privées, triées par activité.
- **Moi** : profil, statut, réglages, sécurité, à propos.
- Sur tablette ou en paysage large (≥ 768 px), la mise en page ordinateur
  actuelle s'applique (seuil `useIsMobile` inchangé).

### 3.3 Salons vocaux : fini la connexion par erreur

Aujourd'hui, un seul appui sur un salon vocal y connecte (et la connexion
automatique au démarrage passe donc en vocal). Sur téléphone :

- un appui **ouvre** le salon (son chat, la liste de qui est dedans) ;
- un gros bouton **« Rejoindre la voix »** en bas connecte ;
- la connexion automatique au démarrage ouvre le salon **sans** rejoindre la
  voix sur téléphone.

### 3.4 Chat

- **Appui long sur un message** → feuille : 6 réactions rapides + « + »,
  Répondre, Copier, Épingler, Modifier, Supprimer, Vu par, Signaler.
- **Glisser vers la droite** sur un message → répondre.
- **Image** → visionneuse plein écran (pincer pour zoomer, glisser vers le
  bas pour fermer), Enregistrer (galerie), Partager (feuille de partage
  Android), Copier.
- **Épingles** : la vue complète validée sur le bureau, en feuille.
- **Non-lus** : même logique que sur le bureau (bandeau, flèche avec
  pastille, lecture en descendant) — le code est commun.
- **Saisie** : « + » (galerie, appareil photo, fichier), bouton emoji/GIF qui
  ouvre le panneau à la place du clavier, envoi ; suggestions de mentions
  au-dessus du clavier ; coller une image.
- **Liens** : navigateur externe ; vidéos YouTube/X : aperçu seulement.

### 3.5 Appel en cours

```
┌──────────────────────────────┐
│ ⌄   🔊 Chihuahuatistant  🔒  │
├──────────────────────────────┤
│  ┌────────┐  ┌────────┐      │
│  │ ◉Picsou│  │ Narkow │      │
│  └────────┘  └────────┘      │
│  ┌──────────────────────┐    │
│  │ 🖥 Partage de Picsou  │    │   ← appui : plein écran, paysage,
│  └──────────────────────┘    │     pincer pour zoomer
├──────────────────────────────┤
│  🎙     🎧     🔈     🎵    ✕ │
│ Micro Casque Sortie Sons Quit│
└──────────────────────────────┘
```

- **Sortie** : écouteur / haut-parleur / Bluetooth / filaire (remplace le
  choix de périphériques du bureau).
- **Sons** : soundboard en feuille (grille de boutons).
- **Parler pour transmettre** (option) : un grand bouton à maintenir, à la
  place du raccourci clavier.
- **Notification d'appel** (`CallStyle`, Android 12+) : Micro, Raccrocher ;
  un appui ramène à l'écran d'appel.
- **Écran éteint** en mode écouteur via le capteur de proximité (A5).
- **Image dans l'image** Android quand on quitte l'appli en regardant un
  partage (A5).

### 3.6 Réglages sur téléphone

| Section | Contenu |
| --- | --- |
| Compte | nom, avatar, bannière, statut, supprimer le compte |
| Apparence | thème, accent, taille du texte, fonds animés |
| Notifications | mode (tout / mentions / minimal), par salon, test, « optimisation de batterie » (ouvre le réglage système) |
| Voix | suppression de bruit RNNoise, annulation d'écho, gain auto, activité vocale / parler pour transmettre, sensibilité |
| Sécurité | vérification des appareils, clé de récupération, sessions, utilisateurs ignorés |
| À propos | version, mise à jour, journal à envoyer |

Masqués sur téléphone : raccourcis, overlay des curseurs, memeboard,
transcription, voix clonées, ffmpeg, dispositions et dock, profils
`.sionprofil`, périphériques audio.

## 4. Fonctions : garder, adapter, retirer

| Fonction | Téléphone | Remarque |
| --- | --- | --- |
| Messages, réponses, édition, suppression | ✅ gardé | code commun |
| Réactions, épingles (vue complète), sondages | ✅ gardé | menus en feuilles |
| Emojis, GIF (Klipy), mentions | ✅ gardé | panneau à la place du clavier |
| Non-lus, bandeau, « vu par », frappe en cours | ✅ gardé | logique commune (`premierPlan.ts` fiable sous Chromium) |
| MP, salons en commun, ignorer, signaler | ✅ gardé | |
| Chiffrement, vérification par emojis, clé de récupération | ✅ gardé | même cœur Rust |
| Profil, avatar, bannière | ✅ gardé | |
| Administration | ✅ gardé | déjà adaptée (`AdminPanel` + `useIsMobile`) |
| Voix (rejoindre, micro, casque, qui parle) | 🔧 adapté | Rust natif, route audio au lieu des périphériques |
| Parler pour transmettre | 🔧 adapté | bouton à maintenir ; bouton de casque Bluetooth plus tard |
| Soundboard | 🔧 adapté | jouer : oui ; importer : fichier seulement (pas de yt-dlp) ; découpe gardée |
| Partage d'écran **reçu** | 🔧 adapté | `native_video_transport` → `<canvas>`, plein écran paysage |
| Vidéos dans le fil | 🔧 adapté | balise `<video>` de Chromium (H.264 natif), pas de ffmpeg |
| Images : enregistrer / copier / partager | 🔧 adapté | MediaStore, presse-papiers Android, feuille de partage |
| Notifications | 🔧 adapté | push déchiffré, regroupé par salon, réponse directe, « lu » |
| Mise à jour | 🔧 adapté | pas de plugin updater Tauri sur Android → téléchargement + installation d'APK |
| Émission de partage d'écran | ❌ retiré en 2.1 | MediaProjection possible plus tard, coûteux en batterie |
| Caméra | ⏳ 2.2 | la permission existe ; il faut nourrir LiveKit depuis Camera2 |
| Overlay des curseurs, memeboard par-dessus les jeux | ❌ retiré | concepts de bureau |
| Transcription, résumé, voix clonées (modèles locaux) | ❌ retiré | trop lourd pour un téléphone |
| Son du système partagé, raccourcis globaux | ❌ retiré | |
| Dispositions (dock, cartes), profils `.sionprofil` | ❌ retiré | mise en page fixe sur téléphone |
| Lecteur vidéo natif (ffmpeg), fenêtre PIP bureau | ❌ retiré | remplacés par `<video>` et le PiP Android |
| yt-dlp | ❌ retiré | pas de binaire sur Android |

## 5. Étapes

Chaque étape se termine par un APK installable et un critère vérifié sur un
vrai téléphone.

| Étape | Contenu | Critère de sortie | Taille |
| --- | --- | --- | --- |
| **A0 — Build propre, sans voix** | Retrait du `sed` de `build-android.sh` ; `moteur-matrix-rust` actif sur Android ; `native-voice` compile mais la voix reste masquée ; schéma de versionCode ; signature ; ABI arm64 seule ; migration 1.x → cœur Rust | APK installé **par-dessus** une 1.x ; connexion, reprise sans ressaisie, messages chiffrés anciens lisibles, envoi | M |
| **A1 — Mise en page téléphone** | Onglets, pile de retour, feuilles, bord à bord, clavier, appui long / glisser, visionneuse d'images, réglages réduits, salon vocal ouvert sans connexion | Tests vitest de navigation ; parcours complet à une main sur téléphone | L |
| **A2 — Voix Rust** | Initialisation JNI + `libwebrtc.jar` ; permission micro à l'exécution ; `MODE_IN_COMMUNICATION` + focus audio ; route audio (`setCommunicationDevice`, API 31+, repli haut-parleur/SCO) ; `VoiceCallService` démarré au premier plan (règle Android 14) ; actions de notification → Rust par JNI ; retrait du court-circuit `onPause/onStop` ; appel GSM entrant = micro coupé puis reprise | Appel **30 min écran éteint** téléphone ↔ PC, chiffré, son dans les deux sens ; bascule Bluetooth en appel ; appel GSM entrant | L (risque) |
| **A3 — Partage reçu et médias** | Canvas du partage reçu, plein écran paysage, zoom ; `<video>` ; pièces jointes (galerie, photo, fichier) ; enregistrer / partager | Regarder un partage 1080p 10 min sans décrochage ; envoyer une photo | M |
| **A4 — Notifications** | Canaux (MP, mentions, salons, appel en cours, service push) ; push → JNI : cœur ouvert (ou ouvert sans synchro depuis la session) → déchiffrement → `MessagingStyle` regroupé par salon ; réponse directe (`RemoteInput`) et « Marquer comme lu » envoyés par Rust ; filtrage par mode sur le contenu déchiffré | Téléphone en veille 1 h (Doze), MP chiffré → notification avec expéditeur et texte en moins de 10 s ; réponse depuis la notification arrive chiffrée | L |
| **A5 — Finitions** | Session chiffrée par Android Keystore ; mise à jour intégrée (GitHub `releases/latest` → APK → `PackageInstaller`) ; capteur de proximité ; PiP du partage ; accessibilité ; invite « optimisation de batterie » | Mise à jour bêta → bêta depuis l'appli ; audit TalkBack de base | M |
| **A6 — CI et publication** | Job `android` dans `release.yml` (NDK, cible `aarch64-linux-android`, clé depuis les secrets) ; APK `Sion-<version>-arm64.apk` joint à la release ; `cargo check --target aarch64-linux-android` sur chaque push | Tag de bêta → APK signé sur la release, installable par-dessus la précédente | S |

A0 et A1 peuvent avancer en parallèle de A2 (A1 est du front pur, testable
dans un navigateur à 390 px de large).

### A0 en détail — la migration depuis la 1.x Android

La 1.x Android tourne sur le moteur JS (IndexedDB du WebView). Le chemin
de migration du bureau (`migrationMoteur.ts`, `migration.rs`) s'applique
tel quel : l'ancien moteur exporte ses secrets et clés de salons, le cœur
ouvre un nouvel appareil par mot de passe et les importe, l'ancien appareil
est déconnecté. Conditions :

- **même origine WebView** (`http://tauri.localhost`) que la 1.x, sinon
  l'IndexedDB de l'ancien moteur est invisible — ne pas activer
  `useHttpsScheme` ;
- **même identifiant et même clé de signature**, sinon Android refuse la mise
  à jour et la désinstallation efface tout ;
- le mot de passe est redemandé une fois (Continuwuity exige l'UIA pour un
  jeton de connexion, comme sur le bureau).

## 6. Version, signature, distribution

- **Clé** : `sion-release.keystore` (racine, ignorée par git). Avant tout,
  comparer son empreinte (`keytool -list -v`) à celle d'un APK 1.x installé
  (`apksigner verify --print-certs`). En faire une **sauvegarde hors de la
  machine** : perdue, plus aucune mise à jour en place n'est possible.
- **versionCode** : Tauri calcule `majeur×1 000 000 + mineur×1 000 + patch`
  et ignore la pré-version — toutes les bêtas d'une version auraient le même
  code et ne s'installeraient pas l'une sur l'autre. `build-android.sh` le
  calcule et le passe à Tauri (`--config`, `bundle.android.versionCode`) :
  `majeur×10 000 000 + mineur×100 000 + patch×1 000 + rang`, le rang valant
  N pour alpha.N, 100+N pour beta.N, 500+N pour rc.N et 999 pour la finale.
  2.1.0-beta.1 → 20 100 101, 2.1.0 → 20 100 999 ; toujours au-dessus de la
  1.x (1 000 000).
- **Version de dev** : `build-android.sh debug` produit `com.sion.client.dev`
  (`bundle.android.debugApplicationIdSuffix`), installable à côté de la
  version publiée, avec ses propres données.
- **ABI** : arm64-v8a seulement (plus x86_64 pour l'émulateur en dev).
- **minSdk 26** (Android 8), fait en A0 : canaux de notification et
  services de premier plan sans branches de compatibilité ; les appareils
  Android 7 sont marginaux.
- **Distribution** : APK sur les releases GitHub. Pas de Play Store (service
  push `specialUse`, clé de signature, délais de revue). Obtainium ou la mise à
  jour intégrée (A5) pour suivre les versions.

## 7. Tests

**Automatiques**
- vitest : navigation téléphone (pile de retour, onglets, feuilles), salon
  vocal ouvert sans connexion, connexion automatique sans voix sur téléphone,
  actions de l'appui long.
- cargo : `cargo check --target aarch64-linux-android` en CI (A6) ; tests
  purs de la route audio et du schéma de versionCode.
- Porte existante inchangée (`tsc -b`, lint, vitest, cargo).

**Sur téléphone** (liste à cocher à chaque bêta)
1. Mise à jour par-dessus la version précédente, sans perte de session.
2. Connexion, synchro, messages chiffrés anciens et nouveaux.
3. Vérification par emojis avec le PC.
4. Voix : entrer, parler, entendre, micro/casque, Bluetooth, haut-parleur,
   écran éteint 30 min, appel GSM entrant, perte de réseau (Wi-Fi → 4G).
5. Partage reçu : plein écran, rotation, zoom.
6. Notifications : appli fermée, en veille, mode Ne pas déranger ; clic,
   réponse directe, « lu ».
7. Pièces jointes : photo, fichier, image collée.

**Mesures** : taille de l'APK, mémoire (PSS) au repos et en appel, batterie
sur 1 h d'appel écran éteint, données consommées par heure de vocal.

## 8. Risques

| Risque | Parade |
| --- | --- |
| ADM Java de libwebrtc + extensions audio Sion (proxy APM, RNNoise, mélangeur) jamais essayés sur Android ; bug « ADM bloqué à -1 » du bureau | A2 commence par un appel minimal sans extension, puis active RNNoise et la soundboard une à une |
| `jpeg-rusturbo` (libjpeg-turbo via CMake) à compiler avec le NDK | vérifié dès A0 ; repli : crate `image` (plus lent) pour le partage reçu |
| Android gèle les processus en arrière-plan ; Doze coupe le SSE ntfy | service de premier plan pendant l'appel ; `PushPollWorker` en secours ; invite d'optimisation de batterie |
| Service micro refusé s'il démarre depuis l'arrière-plan (Android 14+) | le démarrer au moment où l'on rejoint, appli visible |
| Taille de l'APK (libwebrtc + matrix-sdk + interface) | arm64 seule, `strip`, LTO ; mesurer dès A0 |
| Mémoire sur téléphone modeste | mesure PSS à chaque étape ; fonds animés coupés par défaut |
| Clé de signature différente de la 1.x | vérification en tout premier (§6) ; sinon, note de version expliquant la réinstallation et la clé de récupération |
| Deux accès au magasin de chiffrement (appli + notification) | un seul processus ; le cœur est un singleton partagé par l'appli et le chemin JNI |

## 9. Ordre proposé

1. **Vérifier la clé de signature** contre un APK 1.x (5 minutes, conditionne
   tout le reste).
2. A0 sur une branche `feat/android` partie de la 2.0 (après la beta 3).
3. A1 et A2 en parallèle ; A2 en premier sur le chemin critique.
4. Bêta Android interne (Picsou, Narkow) après A2 : chat + voix.
5. A3, A4, puis A5 et A6 avant la 2.1.0.

## 10. Décisions ouvertes (avec recommandation)

- **minSdk 26** : recommandé.
- **Push** : garder le service SSE ntfy maison en 2.1 ; UnifiedPush en
  option ensuite (recommandé), pas de Firebase.
- **Émission de partage d'écran sur téléphone** : non en 2.1.
- **Caméra** : 2.2.
- **Tablettes** : mise en page ordinateur au-delà de 768 px (déjà le
  comportement).
- **Play Store** : non ; APK GitHub + Obtainium.
