# Lecteur vidéo natif — pourquoi et comment

*Document de conception, ouvert le 21/09/2026. À tenir à jour : il doit
permettre de reprendre le travail sans rien savoir de la discussion qui l'a
précédé.*

## Le problème

Sion délègue la lecture des vidéos du fil au moteur du webview. Sur Linux,
WebKitGTK ne décode rien lui-même : il construit sa liste de formats à partir
du registre GStreamer, donc le résultat dépend de la distribution, des greffons
installés, du pilote graphique et du compositeur. Sur Windows c'est WebView2,
un autre pipeline, avec d'autres défaillances. **Nous ne contrôlons rien de ce
qui décide si une vidéo s'affiche.**

La conséquence s'est accumulée en contournements, tous écrits entre le 17 et le
21 septembre : sonde de codec WebM, remux préventif en MP4, conversion ffmpeg
conditionnelle, serveur média HTTP local, sonde `dav1d`, chien de garde de
lecture, repli `WEBKIT_DISABLE_DMABUF_RENDERER` pour NVIDIA, bouton
« Installer ffmpeg ». Sept mécanismes, et le problème n'est toujours pas résolu
pour tout le monde.

Le cas qui a déclenché cette conception : un utilisateur sur Manjaro/AMD voit
un **rectangle vert** à la place de la vidéo. Son journal montre pourtant
`readyState=4`, les bonnes dimensions, aucune erreur, et le temps qui avance —
le fichier est décodé, les images n'arrivent simplement pas à l'écran. Sa pile
VAAPI est morte (`vaInitialize failed`). Un plan YUV à zéro converti en RGB
donne exactement ce vert.

Trois hypothèses ont été formulées et démenties avant d'arriver là : décodeur
AV1 absent, AppImage sans `dav1d`, format du fichier. Chacune coûtait une
demi-journée. La leçon est dans le principe retenu ci-dessous.

## Le principe

**Sion sait déjà afficher de la vidéo de façon fiable, hors du webview.** Le
partage d'écran le fait depuis la 2.0 : une surface native — sous-surface
Wayland avec EGL et plans I420 sans copie sur Linux, fenêtre Win32 sur
Windows — qui ne dépend ni de GStreamer, ni des greffons, ni du pipeline du
navigateur. Elle est en production, et elle fonctionne y compris chez
l'utilisateur dont le lecteur HTML rend du vert (vérifié : il voit les partages
d'écran normalement).

Le lecteur du fil est le dernier endroit où l'on demande au webview de décoder
quelque chose. C'est la seule pièce à déplacer.

## L'architecture retenue

1. **Dans le fil** : plus aucune balise `<video>`. Une image d'aperçu générée à
   l'envoi par ffmpeg et jointe à l'événement Matrix (`info.thumbnail_url`,
   prévu par la spécification). Le webview n'a qu'une image à afficher, ce
   qu'il ne rate jamais.
2. **Au clic** : un lecteur natif, une seule vidéo à la fois, dans une fenêtre
   dédiée ou en plein écran — comme le partage d'écran aujourd'hui. Cela évite
   l'enfer du positionnement de surfaces natives au fil du défilement.
3. **Décodage** : `ffmpeg` en **processus séparé**, et surtout pas en
   bibliothèque — voir l'avertissement ci-dessous. Il débite du `rawvideo
   yuv420p` sur un tube, découpé en plans I420 et poussé dans la surface
   native existante. Le drapeau `-re` le fait débiter à la vitesse réelle du
   média : c'est lui qui cadence, il n'y a pas d'horloge à tenir.
4. **Audio** : la même bibliothèque décode la piste audio en PCM, rendu par
   `cpal` — déjà présent dans `cue_playback.rs`.
5. **Synchronisation** : horloge audio maîtresse, présentation des images sur
   leurs PTS. Méthode classique.

Conséquence directe : on peut **supprimer** la sonde `dav1d`, le remux
préventif, la conversion conditionnelle, le chien de garde et le bouton ffmpeg
de lecture. Le code redevient simple, et l'AV1 reste le format d'envoi.

## Ce qui a été mesuré (21/09/2026)

Prototype dans le bac à sable, sur la vidéo AV1 qui posait problème :

```
codec=AV1  576x1022  format=YUV420P  durée=66.2s
300 images décodées en 0.50s — 600 images/s
```

- Le décodeur sort **directement du `YUV420P`**, le format que la surface
  consomme : pas de conversion dans le cas nominal.
- **600 images par seconde** en décodage purement logiciel, soit vingt fois le
  temps réel. Le décodage matériel n'est pas nécessaire à cette résolution — et
  s'en passer est un avantage : cela contourne les piles VAAPI cassées, qui
  sont précisément la cause du rectangle vert.
- La première image a été écrite en PPM et **regardée** avant de conclure. Ce
  n'est pas un plan vide. Ce contrôle est obligatoire ici : le piège de toute
  cette affaire est un pipeline qui se déclare satisfait sans rien produire.

## Pourquoi pas les alternatives

**libmpv** est techniquement le meilleur — API de rendu propre, `wid` = HWND
sous Windows. Mais il est distribué en **GPLv2+** : l'embarquer obligerait à
publier Sion sous GPL et interdirait de refermer le code plus tard. Le dépôt
est public mais sans licence déclarée ; cette porte reste ouverte tant qu'on
n'y touche pas.

**libVLC** est en LGPL et livre des plans I420 par callbacks, ce qui
s'intégrerait bien. Écarté au profit de ffmpeg pour une raison d'économie :
ffmpeg est **déjà** dans le projet pour le transcodage, et l'empaquetage de VLC
(le cœur plus ses greffons, 40 à 80 Mo) est plus lourd.

**`rav1d` + `symphonia` en Rust pur** serait le plus élégant — aucune
dépendance native, binaire autonome. Écarté parce que `rav1d` ne décode que
l'AV1 : il faudrait lui adjoindre un décodeur H.264, un décodeur VP9, un
démultiplexeur MP4 et un décodeur AAC pour lire l'historique du salon.

## Plan et état

| Étape | État |
|---|---|
| 0. Faisabilité du décodage (Linux) | **fait** — voir les mesures ci-dessus |
| 1. Compilation de `ffmpeg-sys` sous Windows | **fait** — voir ci-dessous |
| 2. Décodage → surface native, sans audio | **fait** — validé à l'écran le 21/09 |
| 3. Audio + synchronisation | à faire |
| 4. Contrôles : lecture, pause, position, volume | à faire |
| 5. Aperçu dans le fil (`info.thumbnail_url` à l'envoi) | à faire |
| 6. Suppression de la machinerie webview | à faire |
| 7. Embarquer **le binaire** ffmpeg (AppImage + installeur) | à faire |

### Étape 1 — résultat (21/09/2026)

**Linux** : `ffmpeg-next = "9"` compile tel quel contre le ffmpeg du système.
Attention, la version 7 du crate **échoue** avec les ffmpeg récents (`avfft.h`
a été supprimé) — il faut bien la 9.

**Windows** : validé sur flammemob. Décodage AV1 à **619 images/s**, soit le
même ordre que Linux.

Prérequis, dans l'ordre où ils ont été découverts :

1. **LLVM** pour `libclang`, dont `ffmpeg-sys` a besoin pour générer ses
   liaisons. `winget install --id LLVM.LLVM -e --silent`, puis
   `LIBCLANG_PATH=C:\Program Files\LLVM\bin`. Les runners GitHub l'ont déjà.
2. **Le bon build ffmpeg** — et c'est le piège :
   prendre `ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` chez BtbN, **pas**
   `ffmpeg-master-latest`. Le build *master* est en avance sur ce que le crate
   sait gérer : son `hwcontext_cuda.h` utilise `CUarray` et
   `CUDA_ARRAY3D_DESCRIPTOR`, deux types pour lesquels le crate ne fournit pas
   de bouchon, et la génération des liaisons échoue. Le crate neutralise
   l'inclusion de `<cuda.h>` en définissant lui-même `CUDA_VERSION`, mais ses
   bouchons s'arrêtent à `CUcontext` et `CUstream`.
   Choisir la variante **lgpl** et non gpl : c'est ce qui préserve la liberté
   de licence de Sion.
3. `FFMPEG_DIR` pointant sur la racine extraite (celle qui contient `include\`
   et `lib\`).
4. À l'exécution, les DLL de `bin\` doivent être trouvables.

Inutile d'installer le SDK CUDA : une tentative a été faite dans cette
direction, elle n'était pas la bonne piste.

**Ces prérequis ne servent plus au lecteur**, puisqu'il appelle le binaire
ffmpeg et non la bibliothèque. Ils sont conservés ici : ils restent exacts, et
serviront si un jour le conflit de symboles disparaît.

### L'écueil qui a coûté le plus cher : ffmpeg EN BIBLIOTHÈQUE EST INUTILISABLE ICI

`libwebrtc.a`, que Sion lie pour la voix et le partage, **embarque sa propre
copie de ffmpeg** — 1 684 symboles `av_*`, dont `av_probe_input_format` et
`ffurl_get_protocols`. À l'édition de liens, ces symboles l'emportent sur ceux
de la bibliothèque système, et la copie interne est amputée :

```text
[Sion][lecteur] libavformat 62.17.100 — 0 protocole(s) en entrée :
```

La version système est 63.1.101, et la copie interne n'a **aucun protocole** :
ni `https`, ni même `file`. Une URL donne « Protocol not found », un chemin
local ne marcherait pas davantage.

Aucun ordre de liaison ne corrige cela proprement : un symbole défini dans une
archive statique gagne, et cette archive vient d'une build pré-compilée de
LiveKit. D'où le processus séparé, qui a son propre espace de symboles.

**Leçon de méthode** : le prototype isolé décodait à 600 images/s et validait
« la faisabilité » — il ne liait simplement pas libwebrtc. Toute preuve de
faisabilité d'une bibliothèque native doit être faite **dans le binaire de
Sion**, pas à côté.

### L'autre piège : une surface sans dimensions

Le canvas passé à `registerNativeVideoSurface` ne porte aucun pixel : son
tampon reste à 1×1, c'est la surface native qui peint par-dessus. Il lui faut
donc une **largeur CSS explicite**, sinon la mise en page le réduit à sa taille
intrinsèque. Constaté le 21/09 : une sous-surface de `2x52` pixels, invisible,
alors que les images arrivaient normalement. Poser aussi
`--sion-share-max-height`, dont le service se sert pour borner la largeur
d'après le ratio de la source.

### Étape 7 — pourquoi elle n'est pas optionnelle

L'AppImage publiée aujourd'hui **n'embarque pas `dav1d`** : le CI essaie
`gstreamer1.0-plugins-rs` puis `gstreamer1.0-dav1d`, aucun des deux n'existe
sur le runner Ubuntu, et il se contente d'un `::warning::` que personne n'a lu
pendant quatre jours. Ne jamais reproduire ce motif : une dépendance de lecture
absente doit **faire échouer la construction**, pas émettre un avertissement.

## Le ffmpeg livré ne sait pas aller sur le réseau (22/09/2026)

Le binaire statique que nous embarquons — johnvansickle 7.0.2, lié
statiquement à la glibc — **s'effondre sur la moindre URL**, y compris un
simple `http://example.com/x.mp4` : vidage mémoire immédiat. C'est la
résolution DNS, qui dans une glibc statique exige les greffons NSS du système.
Un fichier local, lui, se lit parfaitement, AV1 compris (dav1d est dedans).

Comme `resolve_ffmpeg` donne désormais la priorité au binaire livré, cela a
rendu **toutes** les vidéos illisibles dans l'alpha 8, avec un message
trompeur : « format illisible, ou ffmpeg absent ».

Correction : **Rust télécharge, ffmpeg décode.** `ramener_en_local` recopie la
source dans `~/.cache/sion/medias` au fil de l'eau et rend un chemin local.
Quatre points s'y jouent :

- **Au fil de l'eau.** Passer le corps par un `Vec<u8>` ferait transiter une
  vidéo d'un gigaoctet par la RAM.
- **Pas dans `/tmp`.** C'est un tmpfs sur Manjaro : le cache y serait en
  mémoire, et perdu à chaque redémarrage.
- **Hors du fil principal.** `lecteur_video_ouvrir` est synchrone, donc
  exécutée sur le fil qui dessine ; y télécharger cent mégaoctets figerait la
  fenêtre. D'où `lecteur_video_precharger`, asynchrone, qui publie son
  avancement sur `lecteur-video-progres`.
- **Pas le film entier pour une vignette.** `ramener_tete` n'en demande que
  les douze premiers mégaoctets. Le serveur peut ignorer l'en-tête `Range` —
  Continuwuity le fait — auquel cas on coupe nous-mêmes la réception. Repli
  sur le fichier complet quand l'index est en fin de fichier.

Le cache est élagué au-delà de quatre gigaoctets, du plus ancien au plus
récent.

## Invariants à ne pas casser

- La surface native est partagée avec le partage d'écran. Le lecteur doit
  cohabiter, pas s'approprier la surface : une seule vidéo à la fois, et le
  partage reste prioritaire.
- Le format d'échange est **I420**, sans copie sur Linux. Toute conversion
  intermédiaire annule le bénéfice.
- Ne jamais conclure qu'une vidéo « se lit » sur la foi d'un `readyState` ou
  d'un code de retour. Regarder l'image.
- **Ne jamais passer une URL à ffmpeg.** Le binaire livré n'a pas de réseau
  utilisable ; c'est Rust qui rapatrie. Voir la section précédente.
