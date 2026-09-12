# Sion Client 2.0.0-alpha.2

Deuxième alpha de la 2.0.0 — **layout modulable, PIP natif, thèmes** — avec
les correctifs de la soirée de test du 12/09 (voix + partage d'écran).

## Nouveautés

### Layout modulable
- **Dock multi-zones** : blocs à droite, en haut ou en bas (membres,
  soundboard, transcription, connexion vocale) — empilés dans l'ordre choisi,
  redimensionnables, détachables en fenêtres flottantes.
- **Mode Réorganiser** (`Ctrl+Shift+L`) : on déplace les blocs dans la grille
  au glisser ; chaque bloc peut revenir au menu d'origine.
- **Presets** Chat / Voix / Streaming ; **sidebar** 3 états (déployée, rail,
  masquée — `Ctrl+B`), redimensionnable, déplaçable à gauche ou à droite.
- **Fonds d'image par panneau** (chat, menu, blocs) : opacité réglable, mode
  **voile** (lisibilité) ou **flou** (image pleine).

### Partage d'écran
- **PIP natif** : une vraie fenêtre OS always-on-top (au-dessus des autres
  applications), glisser pour déplacer, double-clic pour agrandir, position et
  taille **mémorisées entre les sessions**, boutons **retour à Sion** et
  **coupure du son du partage** — ce dernier synchronisé avec la vue.
- **Choix automatique du codec** : chaque client sonde son matériel et
  l'annonce aux autres ; « auto » prend le meilleur codec décodable par tout
  le monde, **matériel d'abord** (H.264/AV1 par GPU). AV1 est exposé en option.
- **Mini-lecteur flottant** pour les vidéos du chat.

### Voix & thèmes
- Voix 100 % Rust : qualité audio, son du partage, echo-cancel, transcription.
- **Thèmes** : section Apparence dans les Réglages, **Sion Dark** et
  **Sion AMOLED**, import/export JSON, appliqués avant le premier rendu.

## Corrections (test du 12/09)
- **Re-partage d'écran invisible** après un arrêt/relance en pleine session
  (la pompe d'événements du moteur pouvait mourir en silence).
- **Son du partage désynchronisé** entre la vue et le PIP.
- **Latence d'ouverture du PIP** (préchauffage de la boucle, plus d'attente du
  moteur, image chaude à la réouverture).
- **Retour sur Sion** depuis le PIP : la fenêtre clignotait sans revenir
  (relève X11 `_NET_ACTIVE_WINDOW` + XWayland).
- Cues vocaux fantômes « membre parti/rejoint » après une reconnexion.
- Saut en bas du chat pendant le chargement d'historique.
- Bouton de téléchargement des vidéos du chat.

## Sous le capot
- Plafonds mémoire : 30 messages par cran, 500 par salon, cache soundboard LRU.
- Découpage du bundle (démarrage plus léger), caches WebKit bridés.
- Sondes de diagnostic média (« images/s reçues ») et de la pompe d'événements.

## Téléchargement
- **Linux** : AppImage (portable, double-cliquer pour lancer)
- **Windows** : installeur NSIS
