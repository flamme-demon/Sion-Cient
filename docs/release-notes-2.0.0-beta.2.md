# Sion Client 2.0.0-beta.2

Deuxième beta de la 2.0, pour **Linux et Windows**. Le gros changement ne se
voit pas : Sion a un **nouveau moteur Matrix**, écrit en Rust, qui remplace
celui qui tournait dans l'interface. L'interface ne s'en occupe plus : elle
dessine, c'est tout.

## À la première ouverture

Sion vous redemande votre **mot de passe, une seule fois**. C'est le passage
au nouveau moteur : il reprend votre ancien appareil, qui est ensuite retiré
de votre compte. Votre appareil reste **vérifié** et vos **messages chiffrés
restent lisibles**, sans clé de récupération ni emojis à comparer.

Si vous arrivez de la 1.x, c'est la connexion habituelle, suivie de la
vérification de l'appareil.

## Nouveau moteur Matrix

- **Une interface plus fluide.** La synchronisation, le chiffrement, les
  médias et les appels tournent désormais hors de l'interface. Mesuré sur un
  même compte, dans un appel : le gel le plus long retombe en moyenne de
  141 à 59 ms, les gels de plus de 100 ms passent de 32 à 2 en dix minutes,
  et l'interface consomme un quart de processeur en moins.
- **Avatars, icônes et images reviennent.** Ils sont téléchargés avec
  authentification : ils s'affichent sur les serveurs qui refusent désormais
  les médias non authentifiés.
- **Voix** : les clés de chiffrement des appels passent directement du moteur
  Matrix au moteur vocal, sans détour par l'interface.
- **Chiffrement** : les éditions, fichiers et GIF sont envoyés chiffrés dans
  les salons chiffrés (l'ancien moteur les envoyait en clair).
- **Plus de participants fantômes** dans la liste des salons vocaux : un
  participant parti sans prévenir n'y reste plus affiché des heures, et
  votre propre appareil efface ses traces au démarrage.

## Corrections

- La soundboard, les sons du salon et le test audio étaient **muets quand on
  était seul** dans un salon vocal.
- Le **partage d'écran** ne reste plus « en partage » sans image quand le
  sélecteur d'écran ne répond pas ou a été annulé : il s'arrête, avec un
  message.
- L'**image agrandie** passe devant la soundboard.
- Moins de processeur au repos : pastille du salon vocal sans clignotement
  permanent, aperçus de la memeboard figés hors survol, fond de panneau
  animé sur sa propre couche.

## Problèmes connus

- **Plantage possible à la reconnexion vocale** : quitter un salon vocal et
  y revenir aussitôt peut fermer Sion. Si cela vous arrive, dites-nous
  l'heure exacte.
- **Couper la memeboard** retire le meme à l'écran, mais laisse finir son son
  (dix secondes au plus).
- **AV1 affiché en vert** sur certaines cartes AMD sous Linux.
- **Android** : pas dans cette version — attendez la 2.1.

## Signaler un problème

Donnez l'heure, votre système (Linux ou Windows) et ce que vous faisiez au
moment du problème : c'est ce qui permet de le retrouver dans le journal.

Sion est désormais sous double licence MIT ou Apache-2.0.
