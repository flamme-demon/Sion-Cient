# Sion Client 2.0.0-beta.5

Correctifs de la première beta Android. Rien ne change sur PC par rapport à
la beta 4 : sous Linux et Windows, inutile de la réinstaller.

## Android

- **Plantage en entrant dans un salon vocal** quand Sion n'avait pas encore
  l'autorisation du micro : Sion la demande désormais avant d'entrer en
  vocal. S'il ne peut pas utiliser le micro, l'entrée en vocal échoue avec
  un message, sans fermer l'application.
- **Notifications** : au tout premier lancement après l'installation, elles
  pouvaient ne pas démarrer avant la relance suivante de Sion.
- **APK trois fois plus léger** : 41 Mo au lieu de 156.

## Installation

Fichier `Sion_Client-2.0.0-beta.5-arm64.apk` ci-dessous, pour les
téléphones 64 bits. Il s'installe par-dessus la beta 4 ou par-dessus
Sion 1.x.

## Problèmes connus

Les mêmes que pour la beta 4 :

- **Plantage possible à la reconnexion vocale** : quitter un salon vocal et
  y revenir aussitôt peut fermer Sion. Si cela vous arrive, dites-nous
  l'heure exacte.
- **Silence en vocal** après une toute première connexion très lente au
  serveur vocal : ni micro ni son, et rejoindre à nouveau ne suffit pas.
  Relancez Sion.
- **Couper la memeboard** retire le meme à l'écran, mais laisse finir son son
  (dix secondes au plus).
- **AV1 affiché en vert** sur certaines cartes AMD sous Linux.
- **Android** : pas de mise à jour depuis l'application, téléchargez chaque
  beta ici. Téléphones 64 bits seulement.

## Signaler un problème

Donnez l'heure, votre appareil (Linux, Windows ou Android) et ce que vous
faisiez au moment du problème : c'est ce qui permet de le retrouver dans le
journal.
