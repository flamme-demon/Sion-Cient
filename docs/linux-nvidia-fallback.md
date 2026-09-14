# Page blanche Linux — repli NVIDIA (renderer DMA-BUF de WebKitGTK)

Contexte : bug WebKit [303811](https://bugs.webkit.org/show_bug.cgi?id=303811)
« Blank WebView on NVIDIA RTX 50 series (Blackwell) - GBM buffer fail », ouvert
et non résolu. Sur ces pilotes, le web process meurt quelques secondes après le
démarrage sur :

```
Failed to create GBM buffer of size 1200x800: Invalid argument
```

L'appli, elle, tourne (le log montre `[Sion] WS shortcut client connected`) :
seule la page reste blanche, et WebKit la recharge en boucle. Même famille que
[315504](https://bugs.webkit.org/show_bug.cgi?id=315504) (Tauri + pilote 580) ;
[Tauri#9394](https://github.com/tauri-apps/tauri/issues/9394) recense le reste.

Contournement amont : `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Il n'est **pas posé
par défaut** — il coûte une copie d'image par frame et désactive blur
(`backdrop-filter`) et transformées 3D (cf. réponse du mainteneur WebKitGTK dans
le bug 303811). À la place, `gpu_fallback.rs` déclenche une relance unique :

1. le web process meurt (« crashed ») dans les **90 s** suivant le démarrage et
   un pilote NVIDIA est chargé ;
2. un marqueur est écrit dans le dossier de config ;
3. l'appli est relancée **une fois** avec `WEBKIT_DISABLE_DMABUF_RENDERER=1` ;
4. ensuite, `main()` relit le marqueur à chaque lancement et repose la variable
   avant l'init GTK. Aucune autre relance n'a jamais lieu.

Un crash **en pleine session** (mémoire, partage d'écran) ne déclenche rien :
WebKit recharge la page tout seul, on ne tue pas l'appel en cours.

## Variables

| Variable | Effet |
|---|---|
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | Force le contournement manuellement (gagne toujours). |
| `WEBKIT_DISABLE_DMABUF_RENDERER=0` | Réclame le chemin rapide : le repli ne se déclenchera pas. |
| `SION_DISABLE_GPU_FALLBACK=1` | Coupe toute la mécanique de repli. |
| `SION_GPU_FALLBACK_FORCE=1` | Diagnostic : traite la machine comme NVIDIA (test de bout en bout sur un GPU sain). |

## Remise à zéro

Après une mise à jour de pilote, réactiver le renderer DMA-BUF :

```bash
rm ~/.config/com.sion.client/webkit-disable-dmabuf-renderer
```

Le marqueur contient la date et l'âge du process au moment du crash.

## Côté lanceur

`build-scripts/diagnose-linux.sh` teste les contournements connus un par un
(`WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`,
`SION_KEEP_WAYLAND`) et capture sortie terminal + journal pour un rapport.
