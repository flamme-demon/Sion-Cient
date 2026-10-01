# Sion Client 2.0.0-beta.6

Le retour de trois fonctions vocales de la 1.x, des notifications Android
fiables et protégées, et plusieurs corrections.

## Vocal

- **Régler le volume d'une personne** (0 à 200 %) ou **couper son son pour
  soi** : clic droit sur elle dans la liste de l'appel. Le réglage vaut
  pour tous ses appareils et reste d'un appel à l'autre. Une personne coupée
  porte un haut-parleur barré dans la liste.
- **Latence affichée** à côté de « Connecté », avec la qualité de la
  connexion ; aussi dans la barre vocale du téléphone.
- **Silence définitif** après une toute première connexion très lente au
  serveur vocal : corrigé, plus besoin de relancer Sion.
- **Départ et retour d'un participant** à nouveau sonnés après une
  reconnexion (ils restaient muets).
- **Raccrocher** joue le son de départ, et non plus celui de connexion
  perdue, chez les autres.

## Messages

- **Vidéos aux dimensions impaires** (des captures d'écran, souvent) : elles
  se lisent, au lieu de « Lecture impossible — dimensions inexploitables ».
- **Messages privés** : l'avatar de la personne remplace le « # », dans la
  liste comme dans la barre réduite. Le salon d'administration a son
  bouclier, et en barre réduite les salons sans image montrent l'initiale de
  leur nom.

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

- **Plantage possible à la reconnexion vocale** : quitter un salon vocal et
  y revenir aussitôt peut fermer Sion. Si cela vous arrive, dites-nous
  l'heure exacte.
- **Android, Sion fermé** : la notification dit « Nouveau message » sans le
  texte ni l'auteur (un poke compris) : ils sont chiffrés, et seul Sion
  ouvert sait les lire. En mode « Mentions », seuls les messages privés
  notifient alors.
- **AV1 affiché en vert** sur certaines cartes AMD sous Linux.
- **Android** : pas de mise à jour depuis l'application, téléchargez chaque
  beta ici. Téléphones 64 bits seulement.

## Signaler un problème

Donnez l'heure, votre appareil (Linux, Windows ou Android) et ce que vous
faisiez au moment du problème : c'est ce qui permet de le retrouver dans le
journal.
