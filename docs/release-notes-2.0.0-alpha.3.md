# Sion Client 2.0.0-alpha.3

Troisième alpha — les **correctifs de la soirée de test du 13/09** (page blanche
chez un testeur NVIDIA, deux crashs audio pendant le partage, overlay curseurs
qui ne s'ouvrait plus) et le retour de la fenêtre principale en **Wayland
natif**.

## Fenêtre principale

- **Wayland natif par défaut** : plus de `GDK_BACKEND=x11` forcé — netteté et
  gestes du compositeur, et on évite le chemin X11/XWayland où le bug GBM/NVIDIA
  frappe. Opt-in pour l'ancien comportement : `SION_FORCE_X11=1`.
- Le **PIP natif** et l'**overlay curseurs** restent en X11/XWayland :
  l'always-on-top n'existe pas pour un toplevel Wayland ordinaire.
- Conséquence assumée : le bouton **« retour à Sion »** du PIP passe par la
  demande d'attention du compositeur (l'entrée clignote). La sortie propre
  (`xx-pip-v1`) attend que les compositeurs l'activent.

## Overlay curseurs — il refonctionne

- Depuis l'alpha 2, l'overlay **ne s'ouvrait plus** : winit n'autorise qu'une
  `EventLoop` par processus, et le préchauffage du PIP prenait la sienne
  (`RecreationAttempt`). L'overlay a désormais son propre hôte X11
  (`x11rb` + MIT-SHM) — le PIP garde son préchauffage.
- Fenêtre **groupée avec Sion dans la barre des tâches**, au-dessus de tout,
  traversante aux clics, présente sur tous les bureaux.
- Suit les changements d'écran (extinction/rallumage, résolution modifiée en
  plein partage) et diffère son ouverture si l'écran n'a pas de sortie active.
- Le rendu est inchangé (même code de dessin qu'en alpha 1) ; Windows garde son
  hôte winit.
- Diagnostic : `SION_OVERLAY_OPEN=1` ouvre l'overlay avec un curseur factice.

## Page blanche sous pilote NVIDIA

- **Repli automatique** : si le web process meurt dans les 90 s suivant le
  démarrage **et** qu'un pilote NVIDIA est chargé, le client écrit un marqueur,
  relance **une seule fois** avec `WEBKIT_DISABLE_DMABUF_RENDERER=1`, et repose
  la variable aux lancements suivants. Plus rien à retenir par cœur.
  - Remise à zéro après une mise à jour de pilote : supprimer
    `~/.config/com.sion.client/webkit-disable-dmabuf-renderer`.
  - Les valeurs posées à la main gagnent toujours (`=0` réclame le chemin
    rapide) ; `SION_DISABLE_GPU_FALLBACK=1` coupe le repli.
- **Décodeur NVIDIA durci** : une session NVDEC qui échoue fait maintenant
  basculer le décodage en **logiciel** au lieu d'abandonner le processus
  (abort constaté en regardant un partage). La sonde d'ouverture teste une
  vraie session cuvid, plus un simple `dlopen`.
- `LK_DISABLE_NVDEC=1` reste disponible pour forcer le décodage logiciel.
- Nouveau script de diagnostic : `build-scripts/diagnose-linux.sh` (essaie les
  contournements connus et capture sortie + journal).

## Partage d'écran

- **Deux crashs corrigés** (partage avec le son) : la pompe audio du partage
  est maintenant **jointe avant la dépublication** des pistes. Elle pouvait
  sinon pousser sa dernière frame dans une piste déjà détruite (`SIGSEGV`) ou
  croiser le micro sur le même flux d'envoi (`SIGABRT`).

## Réglages

- **Ouverture instantanée** : les écrans lourds se préchargent 300 ms après la
  connexion **et** au survol du bouton ; les détections de l'onglet
  « Avancé » (ffmpeg, yt-dlp, moteur TTS, llama) ne partent plus qu'à
  l'ouverture de cet onglet — avant, elles se déclenchaient à chaque ouverture
  du panneau, dont deux requêtes réseau.
- `detect_ffmpeg` et `detect_ytdlp` passent en asynchrone : ils lançaient un
  sous-processus sur le fil principal, au moment même du clic.

## Sous le capot

- Overlay découpé par plateforme : tronc commun, `cursor_overlay_x11.rs`,
  `cursor_overlay_winit.rs`.
- `docs/linux-nvidia-fallback.md` : mécanisme de repli, variables, remise à
  zéro.
- Le patch vendored `webrtc-sys` est documenté dans `SION_PATCH.md`.

## Téléchargement

- **Linux** : AppImage (portable, double-cliquer pour lancer)
- **Windows** : installeur NSIS
