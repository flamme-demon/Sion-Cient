# Ressources livrées avec l'application

Ce dossier est copié tel quel dans le paquet — AppImage, installeur Windows —
et son contenu se retrouve à côté de l'exécutable chez l'utilisateur.

## ffmpeg

`ffmpeg` (ou `ffmpeg.exe`) y est déposé **au moment de la construction**, par
`build-scripts/fetch-ffmpeg.sh`. Il n'est pas versionné : 76 Mo n'ont rien à
faire dans l'historique d'un dépôt.

Sion en a besoin pour trois choses : lire les vidéos du fil, en extraire
l'affiche, et convertir celles qui dépassent la limite d'envoi du serveur.
Compter sur celui du système laissait ces fonctions muettes chez qui ne l'a
pas, et le téléchargement au premier usage ne sert à rien hors ligne.

Le code le cherche dans cet ordre : chemin choisi dans les réglages, binaire
livré ici, téléchargement géré, voisin de l'exécutable, emplacements usuels,
`PATH` (voir `resolve_ffmpeg` dans `lib.rs`).

Ce fichier existe aussi pour que le motif `resources/*` de `tauri.conf.json`
trouve toujours quelque chose : sur un dossier vide, la construction échoue.
