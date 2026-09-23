# Reprise — surface vidéo native du partage d'écran

> **Document historique.** Il décrit l'état du 16-17/09. L'état courant du
> partage natif — rendu à la demande, agrandissement bicubique, vidéo percée
> sous les menus, surface Windows — est tenu dans
> [`roadmap-2.0.0.md`](roadmap-2.0.0.md), §2.3.

Dernière mise à jour : **16/09/2026** (3e passe : validation interactive), branche
`feat/native-voice-no-cef`. Ce document décrit l'état **non commité** du
chantier avant la publication de `2.0.0-alpha.5`.

## But utilisateur

Le partage reçu doit rester net et fluide sans ralentir les clics, le champ de
texte, les indicateurs vocaux ni les sons. Les pixels ne doivent plus passer
par JPEG, Blob, canvas ou JavaScript. Le PIP système et le lecteur intégré
doivent consommer la même frame native décodée une seule fois.

## État réellement atteint

- LiveKit/libwebrtc décode la frame I420 en Rust, la réduit à la plus grande
  surface physique visible puis la convertit en BGRA via libyuv.
- Le PIP système reçoit directement ce BGRA et reste fluide, sans
  recompression.
- Le lecteur principal Linux charge le BGRA dans une texture d'un
  `GtkGLArea`, placé au-dessus de WebKit dans le `GtkOverlay` créé par le fork
  ciblé de `tauri-runtime-wry`.
- Le front ne conserve qu'un canvas `1x1` servant de placeholder de géométrie
  et d'interactions. Il publie les rectangles seulement lorsqu'ils changent.
- Le rendu est latest-wins : une frame en attente maximum par expéditeur, pas
  de backlog.
- Le lecteur Windows utilise un HWND enfant et `StretchDIBits`; il compile
  mais attend toujours une validation sur une vraie machine Windows.
- Le PIP interne DOM a été supprimé à la demande ; le PIP système natif reste.

Corrections déjà faites pendant la validation du 16/09 :

- le ratio CSS d'une tuile ne suit plus les dimensions sentinelles `1x1`, ce
  qui supprime la mosaïque qui « danse » ;
- la frame est pré-réduite à la taille physique cible et le blit GL final est
  en `GL_NEAREST`, pour ne pas flouter deux fois le texte ;
- la position des curseurs utilise le même rectangle `contain`/letterbox que
  l'image ;
- le vieux calque curseur DOM n'est plus dessiné par-dessus la surface native
  (il calculait encore ses coordonnées depuis le canvas `1x1`).
- les rectangles envoyés au renderer natif ont un premier filtrage avec les
  ancêtres DOM qui coupent le contenu (`overflow: hidden/auto/clip`), mais cette
  protection ne remplace pas encore un clipping Wayland complet.

## Ce qui a été corrigé lors de la 2e passe du 16/09

Deux causes distinctes avaient été confondues sous « ça rame ».

### Cause 1 — l'interface ralentie : la vidéo était dans le graphe WebKit

`GtkGLArea` est un frère de la WebView dans le **même toplevel GTK**. Chaque
`queue_render()` damage une zone du `GtkOverlay` qui recouvre la WebView ; GTK3
repeint la région, `WebKitWebViewBase::draw` re-blitte sa couche de composition
accélérée et réveille le web process. D'où la mesure du 16/09 :

| Processus | CPU observé |
|---|---:|
| `sion-client` | ~52 % d'un cœur |
| `WebKitWebProcess` | ~38 % d'un cœur |
| `kwin_wayland` | ~15 % d'un cœur |

Aucun réglage GL ne corrige ça : tant que la surface est dans ce graphe, WebKit
paie chaque image. **Correctif : la sous-surface EGL** (voir plus bas).

S'y ajoutait un `timeout_add_local(16 ms)` posé inconditionnellement par
`attach()` **pour la durée de vie de l'application** — 60 réveils du thread GTK
par seconde, partage ou non. Il est désormais armé et désarmé par
`arm_drain()`, au fil des rectangles publiés.

### Cause 2 — la vidéo saccadée : la pompe suivait encore le budget JPEG

`spawn_video_pump` empruntait le `tokio::time::interval(40 ms)`
(`VIDEO_TICKS_MS[0]`) et la structure « une conversion en vol, récoltée
seulement sur un tick » :

- plafond dur à 25 im/s ;
- chute à 12,5 im/s dès qu'une conversion dépassait 40 ms ;
- battement contre le drain GTK à 16 ms : chaque image affichée avec 0, 16 ou
  32 ms de retard, irrégulièrement — du judder à cadence pourtant stable.

Le mode natif a maintenant son propre chemin, sans ticker : la frame la plus
récente part dès que la précédente est convertie, le latest-wins interdisant
tout backlog. La récolte se fait par une branche `select!` sur le `JoinHandle`
(annulable, donc sans polling).

Travail mort supprimé au passage, par image 1080p :

- `y_samples` — parcours du plan Y entier dont le résultat n'était plus utilisé
  en natif ;
- `vec![0u8; dw*dh*4]` — 8,3 Mo alloués **et zérotés** par image. `on_frame`
  rend désormais le tampon qu'il remplace (la file est latest-wins, il allait
  être libéré) et la pompe le recycle ;
- la conversion d'une image qu'aucune surface ni PIP n'affiche : si
  `preferred_frame_dimensions` ne rend aucune borne, la frame est jetée avant
  toute conversion.

Effet de bord corrigé : `adapt_budget` n'étant jamais appelé en natif, le log
statistique des 30 s affichait « émises 0,0 im/s ». Le mode natif a maintenant
sa propre ligne (« converties X im/s »).

## Sous-surface EGL — le chemin qui sort WebKit de la boucle

Le squelette du prototype `wl_shm` est conservé (binding sur la connexion
Wayland de GDK, `ObjectId::from_ptr` du `wl_surface` parent, `set_desync`,
région d'entrée vide, position, échelle, région opaque). **Seul le transport
des pixels change** : `wl_egl_window` + `EGLSurface` + contexte GL 3.2 core sur
un **thread dédié**.

Pourquoi pas `wl_shm` tel quel : il sortait bien WebKit de la boucle, mais
payait un `memcpy` de 8,3 Mo par image **sur le thread principal**, relu ensuite
par le compositeur pour l'upload GPU. C'est l'origine des 49–70 % mesurés.

Ce que le chemin EGL supprime :

- le toplevel GTK n'est plus damagé → WebKit ne recompose plus rien ;
- `libyuv::I420ToARGB` disparaît du chemin chaud : les trois plans I420 sont
  téléversés en textures `GL_R8` et la conversion BT.601 plage réduite est
  faite dans le fragment shader — **mêmes coefficients que libyuv**, pour
  qu'aucune couleur ne bouge en basculant entre les deux backends ;
- 1,5 o/px transférés au lieu de 4 ;
- l'ajustement « contain » est fait par l'échantillonneur en `GL_LINEAR` : plus
  de pré-réduction libyuv suivie d'un blit `GL_NEAREST` à recaler ;
- `eglSwapBuffers` cadence sur le vsync du compositeur — bloquer y est sans
  danger, on n'est plus sur le thread d'interface.

Le transport est `native_video_surface::PlanarFrame`, un trait `Send` qui évite
au module de dépendre des types `livekit` (absents sans la feature
`native-voice`). `voice_engine::I420Planes` l'implémente sur le `I420Buffer`
décodé : aucune copie entre libwebrtc et le téléversement GPU.

`prefers_planar(sender)` est faux quand la fenêtre PIP consomme le même
partage — le PIP blitte du BGRA et impose alors la conversion pour tout le
monde. Le shader gère les deux entrées via l'uniforme `u_planar`.

Trois pièges traités, à ne pas réintroduire :

1. **`wl_subsurface.set_position` est double-bufferisé sur le parent.** Sans
   commit du toplevel, une fenêtre dont WebKit n'a rien à repeindre laisserait
   la vidéo à son ancienne place après un scroll. `set_geometry` force donc un
   `invalidate_rect` du parent — au changement de géométrie seulement, jamais
   par image.
2. **Notre file d'événements Wayland est distincte de celle que GDK
   dispatche** : personne d'autre ne la vide. Elle est dispatchée à chaque
   `set_geometry`.
3. **Les objets GL appartiennent au contexte** : le `Program` est détruit
   *avant* `eglMakeCurrent(NULL)`.

### État : opt-in, en attente de validation visuelle

`SION_WAYLAND_SUBSURFACE=1` active le chemin EGL ; le repli `GtkGLArea` reste
le défaut. Limites connues avant d'envisager l'activation par défaut :

- **mosaïque** : le chemin EGL ne sert qu'une sous-surface unique
  (`wants_planar_sender`). Plusieurs partages restent sur `GtkGLArea`. La suite
  propre est une sous-surface par tuile, pas un atlas GL ;
- **curseurs distants** : toujours peints par le `cursor_area` GTK, qui damage
  le toplevel pendant qu'un viewer pointe. À composer dans le shader de la
  sous-surface pour fermer complètement la boucle WebKit ;
- **clipping** : l'intersection des ancêtres `overflow` est faite côté JS, mais
  les **coins arrondis** ne passeront pas par là. Soit on les accepte carrés,
  soit on les compose dans le shader (trivial en EGL, impossible en `wl_shm`) ;
  `wp_viewporter` reste à ajouter pour le crop source ;
- **X11/XWayland** : même shader, fenêtre enfant X11 input-transparent.
  `cursor_overlay_x11.rs` fournit déjà la fenêtre traversante ;
- **Windows** : le HWND enfant existe, `StretchDIBits` → D3D11/ANGLE plus tard.

### Le plafond théorique, hors de portée aujourd'hui

Le vrai zéro-copie serait d'importer le buffer du décodeur VAAPI en dmabuf
(`zwp_linux_dmabuf_v1`) sans jamais toucher les plans côté CPU. Mais
livekit-rust n'expose pas le `NativeBuffer` du décodeur matériel : il rend
systématiquement de l'I420 en mémoire système. Une fois la conversion passée
dans le shader, le gain résiduel est faible.

## Session de validation du 16/09 au soir — mesuré, pas supposé

La sous-surface EGL a tourné plusieurs heures sur la machine de Grégory (KDE
Wayland, Radeon 7900). Verdict utilisateur : **vidéo plus fluide, curseur plus
fluide**. Aucune erreur de présentation en trente minutes, 300 images toutes
les 20 s (cadence de la source).

### Mesure du CPU : attention à l'instrument

`ps -o pcpu` donne la **moyenne depuis le démarrage du processus**, pas la
charge instantanée. Toutes les comparaisons faites avec lui sont invalides.
Mesurer par delta de jiffies sur un intervalle fixe (`/proc/<pid>/stat`, champs
14+15). Relevé correct en EGL, partage actif, build debug :

| Processus | CPU instantané |
|---|---:|
| `sion-client` | 37–50 % |
| `WebKitWebProcess` | 9–15 % |

### Défauts corrigés pendant la validation

- **Position de la sous-surface.** `wl_subsurface.set_position` est relatif au
  `wl_surface` PARENT — fenêtre entière, barre de titre et marges d'ombre des
  décorations comprises — alors que les rectangles du front sont relatifs à la
  WebView. La vidéo se dessinait une centaine de pixels trop haut, par-dessus
  l'en-tête. Corrigé par `translate_coordinates(view → toplevel)`, qui absorbe
  aussi bien la barre de titre que la marge d'ombre du thème.
- **Netteté.** `fit_frame_dimensions` arrondit la frame à des dimensions PAIRES
  (contrainte I420), la sous-surface au pixel supérieur. Un écart d'un pixel
  imposait un facteur d'échelle de 1,002, donc un rééchantillonnage bilinéaire
  sur toute l'image. On colle au 1:1 dès que l'écart est ≤ 2 px.
- **Mosaïque noire.** `accepts_planar()` ne regardait pas l'expéditeur : en
  mosaïque la pompe produisait des plans I420 que `on_planar_frame` rejetait
  faute de cible unique, et rien ne redescendait vers `GtkGLArea`. Le chemin
  planaire est désormais réservé au partage réellement présenté par la
  sous-surface.
- **Rétroaction de taille.** Le front recevait la taille RÉDUITE, qui dérive de
  la géométrie DOM : la boîte fixait le ratio qui fixait la boîte, et l'image
  « dansait ». Le front reçoit maintenant la résolution SOURCE, stable.

### Curseur viewer : cinq causes empilées

Chacune masquait la suivante. Dans l'ordre où il a fallu les lever :

1. la résolution du flux n'atteignait plus le front après un rechargement de
   page (`FRAME_SIZES` survit côté Rust, la map du front repart vide, et
   l'annonce était dédoublonnée) ;
2. le repli sur le backing-store d'un canvas de surface native fabriquait un
   ratio 2:1 à partir des 300×150 par défaut ;
3. l'élément débordait l'image de bandes noires inertes ;
4. **`GtkOverlay` crée une `GdkWindow` DÉDIÉE par enfant superposé**, et c'est
   elle qui capte le pointeur — y compris pour un enfant sans fenêtre propre.
   Tester `has_window()` saute exactement la fenêtre à neutraliser. Seuls les
   franchissements de bordure produisaient encore un `mousemove` ;
5. cette propriété est perdue au `show()` : la fenêtre enfant est refaite au
   mapping. Il faut la ré-affirmer à chaque affichage, pas une fois au
   démarrage.

**Méthode qui a débloqué l'enquête** : `SION_DISABLE_NATIVE_VIDEO_SURFACE=1`.
En retirant tout le sous-système natif, le curseur fonctionnait parfaitement —
ce qui a innocenté d'un coup le DOM, la géométrie, l'émetteur et les
coordonnées. À réutiliser au premier doute.

### Piège d'instrumentation à connaître

`CURSOR_TX_COUNT` et le log `[Sion][Cursor] tx` sont incrémentés **avant** la
publication réelle. « tx 10/s » ne prouve donc PAS la livraison. Et un échec de
`publish_data` n'est journalisé nulle part : il remonte à JS où un
`.catch(() => {})` l'avale. Prévoir une trace côté Rust avant de conclure quoi
que ce soit sur l'émission.

### Overlay du partageur : asymétrie ouverture/fermeture

`openCursorOverlay()` n'est appelé qu'à la transition « je commence à
partager » ; `closeCursorOverlay()` l'est depuis trois endroits, dont la remise
à zéro de session vocale de `useLiveKit`, sans condition. Une reconnexion
vocale, un rejoin ou un rechargement de webview PENDANT un partage ferme donc
l'overlay définitivement — plus aucun curseur de viewer, et rien ne le rouvre
tant que le partage n'est pas relancé. Corrigé : la remise à zéro rouvre
l'overlay si un partage est actif. **Non validé** faute d'accès à la machine
partageuse.

Rappel : le curseur rouge exige `screenShareCursorOverlay = true` dans les
réglages **du partageur**, désactivé par défaut.

### Son des retours d'action

En appel, l'ADM natif détient le périphérique et la sortie audio de WebKit
attend : 2 à 3 s entre l'appel à `play()` — qui se résout pourtant tout de
suite — et le son audible. Assez pour que le son du mute se fasse entendre
après le clic sur unmute, ce qui s'entend comme un son joué deux fois.
`mute`, `unmute` et `undeafen` passent désormais par le moteur Rust, comme la
soundboard en appel. **`deafen` ne le peut pas** : ce chemin alimente le rendu
WebRTC, que la sourdine rend justement silencieux — le clip y est accepté puis
inaudible. Il garde le chemin DOM et sa latence.

## Impasses déjà payées — ne pas rouvrir

- une netteté par shader d'unsharp 5 taps (retirée) ;
- le remplacement du scale libwebrtc par un appel direct `webrtc::I420Scale` :
  `cargo check` passe, le **lien** échoue sur un symbole non exporté ;
- libVLC/GStreamer pour le partage WebRTC : étage de démux inutile, et ça ne
  touche pas la composition de la surface LiveKit. Reste une piste séparée pour
  les **fichiers** WebM/AV1 du chat.

### Pourquoi ce n'est pas déjà une API WRY

WRY sait créer une WebView enfant sur Linux X11. Son exemple officiel
`winit + wgpu` dessine dans la fenêtre native et met une petite WebView enfant
par-dessus, mais refuse explicitement Wayland. Pour X11 + Wayland, WRY
recommande `build_gtk` dans un conteneur GTK ; c'est la famille du chemin
actuel, et non une API de « trou vidéo » dans le DOM.

Références utiles :

- WRY, exemple `wgpu` :
  <https://github.com/tauri-apps/wry/blob/dev/examples/wgpu.rs>
- WRY, WebView GTK / child webviews :
  <https://github.com/tauri-apps/wry#child-webviews>
- spécification `wl_subcompositor` (le cas vidéo est cité explicitement) :
  <https://wayland.freedesktop.org/docs/html/apa.html#protocol-spec-wl_subcompositor>
- `GstVideoOverlay`, autre exemple du même modèle « surface native fournie au
  renderer » :
  <https://gstreamer.freedesktop.org/documentation/video/gstvideooverlay.html>

## Point de départ technique pour la reprise

Fichiers principaux :

- `src-tauri/src/native_video_surface.rs` : renderer Linux GTK/GL et renderer
  Windows HWND/GDI, frames et curseurs latest-wins ;
- `src-tauri/vendor/tauri-runtime-wry/` : création du `GtkOverlay` avant la
  WebView et correction du parcours d'ancêtres pour le resize sans bordure ;
- `src/services/voiceNativeService.ts` : publication des rectangles et taille
  physique demandée ;
- `src/components/chat/ScreenShareView.tsx` : placeholders/tuiles et calque
  curseur DOM désactivé en mode natif ;
- `src-tauri/src/pip_window.rs` : bon exemple de consommateur BGRA natif ;
- `src-tauri/src/cursor_overlay_x11.rs` : bon exemple x11rb + MIT-SHM + fenêtre
  traversante.

Dépendances directes Linux désormais nécessaires (`Cargo.toml`) :
`wayland-client 0.31` (feature `system`), `wayland-sys 0.31`,
`gdkwayland-sys 0.18`, `wayland-egl 0.32`, `khronos-egl 6` (feature `dynamic`)
et `libloading 0.8`.

Attention : le `wl_surface` parent et la sous-surface doivent utiliser **la même
connexion Wayland** que GDK ; une seconde connexion ne peut pas référencer
l'objet parent. C'est pourquoi `Backend::from_foreign_display` emprunte le
`wl_display` exposé par `gdk_wayland_display_get_wl_display`.

Étapes suivantes :

1. valider visuellement le chemin EGL contre le repli, sur le même partage :
   réactivité des clics, CPU `WebKitWebProcess`, cadence, netteté, couleurs ;
2. composer les curseurs distants dans le shader de la sous-surface, puis
   retirer le `cursor_area` GTK en mode EGL ;
3. une sous-surface par tuile pour la mosaïque ;
4. `wp_viewporter` pour le crop source, et décider du sort des coins arrondis ;
5. implémenter le chemin enfant X11, puis tester DPI, resize, plein écran et
   multi-écrans ;
6. conserver le backend GTK comme repli jusqu'à validation Linux + Windows.

## Vérifications déjà vertes

```bash
npx tsc -b          # 0
bun run lint        # 0 (34 avertissements préexistants)
bun run test        # 237 tests
cargo test --features native-voice -j4      # 96 tests
cargo clippy --features native-voice -j4 --all-targets   # 0
cargo build --features native-voice -j4 --bin sion-client  # vérifie le LIEN
git diff --check
```

`cargo check` ne lie pas : c'est `cargo build --bin` qui valide réellement
`libwayland-egl` / `libEGL`.

Relance de développement :

```bash
# repli GtkGLArea (défaut)
./build-scripts/run-native.sh
# sous-surface EGL, volontairement opt-in tant que curseurs, mosaïque et
# clipping arrondi ne sont pas traités
SION_WAYLAND_SUBSURFACE=1 ./build-scripts/run-native.sh
```

Ne pas lancer/committer/publier Alpha 5 avant validation interactive explicite
de la fluidité, de la netteté et des curseurs par l'utilisateur.
