# Sion Client 2.0.0-beta.1

Première beta de la 2.0, pour **Linux et Windows**. Tout ce que la 2.0 doit
contenir est là ; cette beta sert à trouver ce qui casse encore avant la
version finale. Android reviendra, compatible, avec la 2.1.

## Nouveautés depuis l'alpha 9

### Apparence

- **Couleur d'accent** au choix, par-dessus n'importe quel thème : sept
  pastilles et une couleur libre, dans Réglages → Apparence. Elle ne touche
  que boutons, liens, sélection et onglets ; les fonds restent ceux du
  thème. Chaque couleur est déclinée en nuances lisibles, en clair comme en
  sombre.
- **Aperçu au survol** : survoler un thème ou une pastille l'applique le temps
  du survol.
- Un thème importé qui se lirait mal est signalé à l'import, avec la paire de
  couleurs en cause.

### Profils

- **Exporter et importer un profil** (`.sionprofil`) : disposition, thème et
  accent, fonds de panneaux, sons d'événements, une case par partie. Pour
  retrouver son Sion sur une autre machine, ou le partager. Dans Réglages →
  Profil et dans le menu « Dispositions ».
- À l'import, rien ne s'applique avant « Appliquer » ; les fonds et les sons
  du profil remplacent les vôtres.

### Vidéo sous Windows

- Les boutons du **lecteur vidéo** du fil répondent : pause, barre de lecture,
  volume, fermeture, double-clic.
- Le plein écran du lecteur passe par la fenêtre de Sion ; Échap en sort.
- Votre pointeur ne s'affiche plus sur le lecteur des autres quand vous
  survolez le vôtre — ni le leur sur le vôtre.
- Un partage d'écran affiché plus grand que sa taille d'origine est agrandi
  en douceur, au lieu d'être étiré pixel par pixel.

### Divers

- Les vidéos épinglées ont une vraie image d'aperçu.
- Une statistique réseau illisible ne fait plus planter Sion.
- Les fichiers temporaires de vidéos sont de nouveau nettoyés.

## La 2.0 en bref

Pour qui arrive de la 1.x :

- **Voix 100 % Rust**, sans le moteur Chromium embarqué : plus léger, et la
  même voix sous Linux et Windows.
- **Partage d'écran natif** : la vidéo est peinte directement, sans passer par
  la page ; fenêtre flottante système (PIP), mosaïque de partages, curseurs
  des spectateurs.
- **Lecteur vidéo natif** pour les vidéos du fil, avec ffmpeg fourni.
- **Memeboard** : de courts memes vidéo qui surgissent chez tout le salon.
- **Disposition modulable** : panneaux déplaçables en haut, à droite ou en
  bas, en onglets ou en cartes flottantes, et dispositions toutes prêtes.
- **Thèmes** : Sion Dark, Sion Light, AMOLED, import de thèmes, couleur
  d'accent.

## Problèmes connus

- **Plantage possible à la reconnexion vocale.** Observé une fois : le son du
  micro repartait pendant que le codec était reconfiguré. Si Sion se ferme
  seul en rejoignant un salon, dites-nous l'heure exacte.
- **Couper la memeboard** retire le meme à l'écran, mais laisse finir son son
  (dix secondes au plus).
- **AV1 affiché en vert** sur certaines cartes AMD sous Linux.
- **Android** : pas de voix dans cette version — attendez la 2.1.

## Signaler un problème

Donnez l'heure, votre système (Linux ou Windows) et ce que vous faisiez au
moment du problème : c'est ce qui permet de le retrouver dans le journal.
