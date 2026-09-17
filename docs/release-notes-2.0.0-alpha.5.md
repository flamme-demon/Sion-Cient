# Sion Client 2.0.0-alpha.5

Cinquième alpha — le partage d'écran principal passe au **rendu natif sans
pixels dans JavaScript**, la lecture vidéo WebM/AV1 est réparée, les sons
d'événements sont de nouveau fiables et la persistance locale est durcie.

## Partage d'écran natif

- **Linux / Wayland** : les frames I420 sont converties puis peintes directement
  dans une surface GTK/GL intégrée à la fenêtre. La WebView n'échange plus que
  la géométrie des zones visibles ; aucun JPEG ni pixel ne traverse JavaScript
  sur le chemin normal.
- La surface native est **active par défaut**, avec une région d'entrée vide :
  boutons, champs et interactions de Sion restent cliquables au-dessus du
  rendu. Un opt-out `SION_DISABLE_NATIVE_VIDEO_SURFACE=1` reste disponible pour
  le diagnostic.
- **Windows** : première surface intégrée HWND/GDI, une fenêtre enfant par
  zone vidéo, suivi du DPI et hit-test traversant. Elle est également activée
  par défaut ; la validation sur une machine Windows réelle reste à terminer.
- Le **PIP système natif** partage les mêmes frames BGRA sans recompression et
  conserve son rendu, son volume et ses contrôles lors des transitions.
- La boucle de géométrie de la WebView ne tourne plus à chaque frame écran :
  elle ne republie les rectangles que lorsqu'ils changent, ce qui réduit
  nettement l'activité CPU pendant un partage.

> Validation avant publication : sous Linux/Wayland, les pixels sont bien
> natifs mais le `GtkGLArea` partage encore le toplevel de WebKit et peut
> ralentir l'interface pendant un flux. La migration vers une
> `wl_subsurface` indépendante est en cours ; Alpha 5 ne doit pas être publiée
> avant validation de cette fluidité.

## Vidéos du chat

- Les fichiers **WebM AV1** produits par l'import YouTube sont identifiés par
  leur vrai codec au lieu d'être rejetés sur la seule base du conteneur.
- Le lecteur retombe proprement sur l'ouverture externe quand le moteur de la
  plateforme ne sait réellement pas décoder le codec.
- Le mini-lecteur interne, devenu incohérent avec ces chemins et non souhaité,
  est supprimé.

## Sons vocaux et d'événements

- Les sons `mute`, `unmute`, `deafen`, `undeafen`, arrivée, départ, timeout,
  poke et kick sont lus via une URL Blob compatible WebKitGTK. Cela corrige le
  cas où seul le premier MP3 de la session était décodé et tous les suivants
  devenaient silencieux.
- Les sons personnalisés, leur rognage et leur gain restent pris en charge ;
  un fichier manquant retombe sur le son embarqué puis sur le timbre synthétique.
- Les anciens snapshots de réglages sont migrés sans effacer les associations
  de sons encore présentes.

## Fenêtre, session et réglages

- Position, taille, maximisation et plein écran de la fenêtre sont sauvegardés
  en continu et restaurés après l'initialisation WRY.
- `sion-settings` est maintenant versionné et migré explicitement.
- `session.json` est remplacé atomiquement, synchronisé sur disque et conservé
  en mode privé : un crash pendant l'écriture ne doit plus tronquer la session.
- L'hydratation du stockage global se fait avant le chargement des stores, pour
  éviter qu'une valeur par défaut réécrive des réglages restaurés au démarrage.
- La base crypto Matrix est désormais isolée dans un stockage IndexedDB Sion
  versionné. Une ancienne base bloquée ne peut plus laisser le WASM crypto
  saturer WebKit ni retarder les clics et les sons de plusieurs secondes.
- Un timeout crypto ne lance plus une seconde initialisation concurrente : le
  premier appel WASM n'étant pas annulable, cette relance doublait la charge.

## Interface et thèmes

- Nouveau thème intégré **Sion Light**, disponible dans Apparence.
- La roadmap 2.0.0 est remise en phase avec le lecteur natif, le PIP, les
  migrations de stockage et les validations restantes.

## Socle technique

- Retour sur **Tauri stable 2.11.5**. Seul `tauri-runtime-wry` conserve un
  correctif local ciblé pour imbriquer la WebView Linux dans un `GtkOverlay`.
- Le renderer WebKit accéléré reste actif par défaut. Le rendu logiciel
  DMA-BUF n'est plus forcé avec le partage natif et reste un repli de crash ou
  un diagnostic explicite ; la zone GTK vide n'est plus mappée/repeinte à 60 Hz.
- Le fallback JPEG/SVF1 reste présent uniquement lorsque la surface native
  n'est pas disponible ; son retrait attend la validation Windows complète.

## Téléchargement

- **Linux** : AppImage (portable, double-cliquer pour lancer)
- **Windows** : installeur NSIS
