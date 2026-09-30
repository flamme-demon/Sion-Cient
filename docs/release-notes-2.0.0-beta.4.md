# Sion Client 2.0.0-beta.4

Quatrième beta de la 2.0, et **première beta Android**. Elle permet de
**connecter son téléphone par QR code**, et corrige plusieurs défauts sur PC.

Si vous avez la beta 3 sur PC, installez simplement celle-ci : pas de mot de
passe à redonner, pas de nouvel appareil.

## Android (première beta)

- **Sion complet sur téléphone** : salons et messages chiffrés, vocal avec
  push-to-talk, partages d'écran reçus, soundboard et memeboard, épingles,
  vidéos.
- **Installation** : fichier `Sion_Client-2.0.0-beta.4-arm64.apk` ci-dessous,
  pour les téléphones 64 bits. Il s'installe par-dessus Sion 1.x. Gardez
  votre **clé de récupération** sous la main pour la première connexion.
- **Notifications sans services Google** : elles arrivent même Sion fermé.
  Toucher une notification ouvre le message, et « Répondre » répond depuis
  la notification.
- **Économe** : la vidéo d'un partage d'écran peut être masquée (données et
  batterie), et les memes ne sont préchargés qu'en Wi-Fi.
- **Qui est sur téléphone** : une icône de téléphone le signale dans la liste
  des participants d'un salon vocal.

## Connecter son téléphone par QR code

- Sur le PC : votre compte → **« Connecter un téléphone (QR code) »**, puis
  votre mot de passe. Le QR code est valable 2 minutes, pour une seule
  connexion : ne le montrez à personne d'autre.
- Sur le téléphone : **« Scanner le QR code du PC »** sur l'écran de
  connexion. Rien à taper.
- Le téléphone demande ensuite à être vérifié : un second QR code s'affiche
  sur le PC, le téléphone le scanne. **Les emojis et la clé de récupération
  restent proposés.**
- Tout se fait dans Sion, sans service extérieur ni services Google.

## Corrections

- **Vocal : quelqu'un qu'on entend mais qui n'apparaît pas dans la liste.**
  Rejoindre un salon vocal juste après avoir ouvert Sion pouvait vous faire
  disparaître de la liste des autres pendant une heure. La correction agit
  chez la personne concernée : passez tous à la beta 4.
- **Windows : voix hachée avec un jeu lourd.** Pendant un appel, Sion ne
  passe plus après le jeu (priorité relevée, pas de bridage en
  arrière-plan) ; tout redevient normal en quittant l'appel.
- **Même compte sur le PC et le téléphone dans un appel** : chaque appareil
  est un participant à part entière (micro et sourdine de chacun).
- **Avatars vides** par endroits après un rechargement de l'affichage
  (Linux).
- **Vidéos** : on peut avancer et reculer dans une vidéo du fil.
- **Vérification d'un appareil** : la demande se voit aussi menu réduit, et
  les anciens messages se déchiffrent juste après.
- **Place sur le disque** : les médias déchiffrés temporaires sont effacés
  (au démarrage après 24 h, et à la déconnexion). Les restes de la 1.x
  (1,3 à 2,5 Go de cache) sont supprimés.
- **Déconnexion** : elle quitte aussi l'appel en cours.

## Problèmes connus

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
