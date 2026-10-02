# Sion Client 2.0.0-beta.6

Un moteur vocal à jour, le retour de trois fonctions vocales de la 1.x, la
reconnexion automatique après une coupure du serveur, des vidéos converties
par la carte graphique, et des notifications Android fiables et protégées.

## Vocal

- **Moteur vocal mis à jour** (LiveKit 0.9) : il corrige un plantage au
  premier échange avec le serveur vocal, des reconnexions annoncées réussies
  alors que le son ne revenait pas, et réécrit la gestion du micro et du
  haut-parleur là où se produisait le plantage à la reconnexion vocale.
- **Reconnexion automatique** quand le serveur vocal redémarre ou que le
  réseau tombe longtemps : Sion rejoint de lui-même le salon, micro coupé et
  sourdine rétablis s'ils l'étaient. « Reconnexion à … (essai N) » s'affiche,
  avec un bouton pour abandonner. Avant, au-delà d'une minute et demie de
  coupure, chacun devait revenir à la main.
- **Régler le volume d'une personne** (0 à 200 %) ou **couper son son pour
  soi** : clic droit sur elle dans la liste de l'appel (appui long sur
  téléphone). Le réglage vaut pour tous ses appareils et reste d'un appel à
  l'autre. Une personne coupée porte un haut-parleur barré dans la liste.
- **Latence affichée** à côté de « Connecté », avec la qualité de la
  connexion ; aussi dans la barre vocale du téléphone.
- **Transcription de réunion** : l'invitation s'affiche de nouveau chez les
  autres quand quelqu'un la lance.
- **Partage d'écran** plus net dès le départ : il n'est plus bridé à 1 Mb/s
  le temps de monter en débit.
- **Silence définitif** après une toute première connexion très lente au
  serveur vocal : corrigé, plus besoin de relancer Sion.
- **Départ et retour d'un participant** à nouveau sonnés après une
  reconnexion (ils restaient muets).
- **Raccrocher** joue le son de départ, et non plus celui de connexion
  perdue, chez les autres.

## Vidéos

- **Conversion par la carte graphique** : une vidéo importée par lien, ou
  envoyée, qui dépasse la limite du serveur est réencodée par la carte
  graphique quand elle le peut. Un reel Instagram de trois minutes : 12
  secondes au lieu de 13 minutes. Sous Linux, sans carte utilisable, le
  processeur seul en met une au lieu de 13.
- **La progression avance** pendant la conversion (elle restait à 0 % quand
  le site ne donnait pas la durée de la vidéo), et **« Annuler » arrête
  vraiment** le téléchargement ou la conversion.
- « Tel quel » ne s'affiche plus quand la taille de la vidéo est inconnue :
  « réencodée si trop lourde ».
- **Vidéos aux dimensions impaires** (des captures d'écran, souvent) : elles
  se lisent, au lieu de « Lecture impossible — dimensions inexploitables ».
- Linux : le ffmpeg livré avec Sion est désormais le même que sous Windows,
  ce qui ajoute 23 Mo à l'AppImage.

## Salons

- **Messages privés** : l'avatar de la personne remplace le « # », dans la
  liste comme dans la barre réduite. Le salon d'administration a son
  bouclier, et en barre réduite les salons sans image montrent l'initiale de
  leur nom.

## Android

- **Appui long** sur une personne (appel, membres) ou sur un message privé :
  il ouvre enfin son menu. Avant, il sélectionnait le texte, et le menu ne
  répondait pas.

## Android : notifications

- **Elles s'affichent en bandeau** au lieu de seulement vibrer, Sion ouvert
  ou en arrière-plan.
- **Toucher une notification ouvre le bon salon**, même quand Android avait
  fermé Sion entre-temps. « Répondre » depuis la notification ne perd plus
  la réponse dans ce cas.
- **Plus de notifications fantômes** : une notification déjà vue ou balayée
  ne revient plus un quart d'heure plus tard.
- **Reconnexion immédiate** au passage du Wi-Fi à la 4G (et retour) : avant,
  la réception pouvait rester coupée sans que rien ne le signale. Les
  messages arrivés pendant une courte coupure sont rattrapés.
- **Adresse de notification secrète** : chaque téléphone reçoit ses avis sur
  une adresse tirée au hasard, que personne ne peut deviner. Rien à faire :
  elle remplace l'ancienne au premier lancement de la beta 6.
- Une notification indique le nombre de nouveaux messages du salon (avant,
  un total de tous les salons).

## Installation

Fichier `Sion_Client-2.0.0-beta.6-arm64.apk` ci-dessous, pour les
téléphones 64 bits. Il s'installe par-dessus la beta 5 ou par-dessus
Sion 1.x.

## Problèmes connus

- **Plantage possible à la reconnexion vocale** : le nouveau moteur vocal
  pourrait l'avoir corrigé, sans certitude. S'il vous arrive que Sion se
  ferme en revenant dans un salon vocal, dites-nous l'heure exacte.
- **Android, Sion fermé** : la notification dit « Nouveau message » sans le
  texte ni l'auteur (un poke compris) : ils sont chiffrés, et seul Sion
  ouvert sait les lire. En mode « Mentions », seuls les messages privés
  notifient alors.
- **AV1 affiché en vert** sur certaines cartes AMD sous Linux.
- **Partage d'une zone sous KDE** (choix « Zone » de la fenêtre de KDE) : les
  curseurs des spectateurs ne tombent pas au bon endroit chez celui qui
  partage, KDE ne donnant pas la position de la zone. Le partage d'un écran
  entier n'est pas touché.
- **Android** : pas de mise à jour depuis l'application, téléchargez chaque
  beta ici. Téléphones 64 bits seulement.

## Signaler un problème

Donnez l'heure, votre appareil (Linux, Windows ou Android) et ce que vous
faisiez au moment du problème : c'est ce qui permet de le retrouver dans le
journal.
