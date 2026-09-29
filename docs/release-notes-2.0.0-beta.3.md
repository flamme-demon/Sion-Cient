# Sion Client 2.0.0-beta.3

Troisième beta de la 2.0, pour **Linux et Windows**. Elle remet en marche
les **notifications**, refait entièrement les **messages non lus**, et
corrige le partage d'écran sur plusieurs écrans.

Si vous avez la beta 2, installez simplement celle-ci : pas de mot de passe
à redonner, pas de nouvel appareil.

## Notifications

- **Elles reviennent.** Depuis la beta 2 (nouveau moteur Matrix), aucune
  mention, réponse ni message privé ne déclenchait de notification.
- **Seulement quand vous n'êtes pas là** : fenêtre de Sion quittée pour une
  autre application, Sion caché, ou une minute sans souris ni clavier (vous
  êtes sur un autre écran, un autre PC). Passer la souris au-dessus de Sion
  ne compte pas comme un retour.
- **Sous Linux**, les notifications restent dans l'historique du bureau. Un
  clic ouvre le message ; sous KDE, **« Répondre »** envoie votre réponse
  directement depuis la notification (chiffrée si le salon l'est).

## Messages non lus

- **Ce qui arrive pendant votre absence reste non lu**, même si Sion est
  ouvert sur le salon, en bas du fil.
- **Bandeau « Nouveaux messages »** : en revenant (ou en ouvrant le salon),
  la vue s'arrête sur le bandeau, les nouveaux messages juste en dessous.
  Il faut descendre pour les lire ; le bandeau s'efface 5 secondes après.
- **Pastille rouge sur la flèche** pour descendre quand des messages non
  lus vous attendent plus bas.
- À l'ouverture d'un salon, Sion remonte l'historique jusqu'à votre dernier
  message lu, même ancien, au lieu de vous poser tout en bas.
- Répondre depuis une notification ne fait pas passer le salon pour lu.

## Autres nouveautés et corrections

- **Épingles** : un message épinglé trop ancien pour être dans le fil
  s'affiche en entier dans une fenêtre, au lieu de faire défiler le fil pour
  rien.
- **Partage d'écran sous KDE avec plusieurs écrans** : les curseurs des
  spectateurs s'affichent sur l'écran partagé, et plus sur l'écran
  principal.

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
- **Android** : pas dans cette version — attendez la 2.1.

## Signaler un problème

Donnez l'heure, votre système (Linux ou Windows) et ce que vous faisiez au
moment du problème : c'est ce qui permet de le retrouver dans le journal.
