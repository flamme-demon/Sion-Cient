# Sion Client 2.0.0-alpha.4

Quatrième alpha — le **rond soundboard** qui s'éteignait avant la fin du son,
le **PIP natif** redimensionnable et un partage d'écran qui ne décode plus deux
fois la même image, plus un durcissement côté sécurité (session, aperçus de
liens, téléchargements).

## Soundboard — le rond jaune suit la musique

Le badge « *X joue un son* » n'était pas lié à la lecture : c'était un minuteur
de la durée annoncée dans le message, armé à l'arrivée du paquet. Trois
scénarios repérés, tous corrigés :

- **Sons qui se chevauchent** : le minuteur d'un son précédent éteignait le
  rond d'un son encore en cours (relance du même raccourci, second son pendant
  le premier). Le badge porte désormais une **échéance** qui ne recule jamais et
  chaque réveil revérifie avant d'effacer — le rond tient jusqu'à la fin du
  dernier son déclenché.
- **Durée manquante ou nulle** : une métadonnée `info.duration` absente tombait
  sur 3 s, et un 0 stocké éteignait le rond instantanément. Les deux clients
  normalisent maintenant la durée (repli 3 s, plafond 60 s) et la diffusion
  envoie la durée **réellement mesurée à la lecture**, plus la métadonnée
  d'upload.
- **Chez celui qui écoute** : le compte à rebours partait avant que son client
  n'ait téléchargé, décodé et mis le clip en file — d'où un rond qui finissait
  systématiquement avant la musique de l'autre. L'échéance est repoussée au
  **démarrage réel de la lecture locale**, sans jamais raccourcir une échéance
  en cours.

Concrètement : le rond de celui qui joue n'a plus besoin qu'il mette à jour son
client pour s'afficher correctement chez vous — le correctif vit dans le client
qui **affiche** le rond.

## Partage d'écran

- **PIP natif** : taille libre, persistée entre sessions (double-clic → preset),
  redimensionnement par les bords, troisième bouton **pointeur** qui publie la
  position du curseur, et préchauffage au lancement — la création de la boucle
  d'événements se paie au démarrage, jamais au premier clic.
- **Un seul décodeur** : la vue web n'ouvre plus de seconde connexion vidéo
  quand le PIP natif est affiché (une seule copie JPEG décodée au lieu de deux).
- **Encodeur matériel générique** : `Hardware` remplace `Vaapi` — la fabrique
  choisit le backend réellement disponible (NVENC, VAAPI, VideoToolbox) et
  retombe en logiciel si le pilote échoue. Le codec par défaut du partage passe
  à **H264**, et les capacités annoncées interrogent ces backends au lieu de
  parser `vainfo` (qui pouvait annoncer un encodeur absent).
- **Pistes mono-couche** : ne plus forcer la couche haute ni les dimensions,
  sinon certains SFU renvoient une couche inexistante — écran noir sans erreur.
  Marge portée à 2560×1440 pour l'ultrawide et le 1440p en simulcast.
- **AV1** : jamais forcé si l'encodeur local ou un pair ne le confirme pas, avec
  repli H264 — plutôt qu'un partage négocié mais indécodable.
- **Curseur distant** : il s'efface correctement en quittant le canvas, y
  compris quand on passe sur les boutons au-dessus (`mouseleave` ne suffit pas
  sous WebKit) ou qu'on quitte l'application.

## Sécurité

- **Session Matrix prête pour le coffre du système** (Secret Service, Keychain,
  Gestionnaire d'identifiants) : le jeton d'accès sort de `session.json` dès
  qu'un coffre l'accepte **réellement** — l'écriture est relue avant de retirer
  la copie disque — et la migration de l'ancien fichier en clair est
  automatique. Le fichier passe en `0600`.
  *Les backends de coffre ne sont pas encore compilés (`keyring` sans feature de
  keystore) : dans cette alpha le jeton reste donc sur disque, mais il n'est plus
  jamais retiré sans être stocké ailleurs — c'était le cas, et ça vidait la
  copie de secours qui sert à survivre à une purge du profil webview.*
- **Aperçus de liens** : refus des schémas non HTTP(S), de `localhost`,
  `.local` et de toute adresse privée, loopback ou link-local — **y compris
  après redirection**. Une URL de message ne peut plus faire du client un proxy
  vers le réseau local.
- **Téléchargements** : nom de fichier assaini (traversée de chemin, séparateurs,
  caractères de contrôle) et corps borné à 512 Mo au lieu d'un chargement
  inconditionnel en mémoire.

## Langue

- Les derniers textes en dur du chat et de la page de connexion passent par la
  traduction ; nomenclature nettoyée (clés plurielles mortes supprimées).

## Sous le capot

- webrtc-sys : `resolve_cuda_home` retrouve un toolkit CUDA versionné (v12.x,
  cuda-12.x) — les builds locaux se comportent comme la CI.
- Journalisation de la connexion du client vidéo WebSocket natif (première
  frame, déconnexion).

## Téléchargement

- **Linux** : AppImage (portable, double-cliquer pour lancer)
- **Windows** : installeur NSIS
