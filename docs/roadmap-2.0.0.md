# Roadmap 2.0.0 — Layout modulable, lecteur natif, PIP système, thèmes

Document vivant pour la 2.0.0 finale, remis en phase avec le code de
2.0.0-alpha.5.

> **État d'avancement (16/09/2026)** —
> ✅ **Chantier 1 (layout)** : socle complet — `useLayoutStore` persisté (v3 +
> migrations), `ResizeHandle` double axe, sidebar 200→400 px / rail 72 px /
> **masquée** (Ctrl+B cycle les trois, poignée de révélation sur le bord),
> dock à **deux zones redimensionnables** (droite 220→520, bas 140→520) avec
> **onglets**, panneaux déplaçables **par menu et par glisser-déposer**, et
> **détachables en cartes flottantes** (glisser, resize, rattacher, position
> et taille persistées) ; `resetLayout`, **presets Chat / Voix / Streaming**
> dans l'en-tête du salon. Bonus : mini-avatars d'occupants (parole/son/AFK/
> micro) + carte de survol complète (rôles, réseau, clic droit).
> ✅ **Chantier 2 (partage natif)** : hauteur réglable persistée, barre d'onglets
> navigateur (son + volume + plein écran), **mosaïque** (tuiles multi-partages,
> son et curseurs par tuile), **PIP interne** (Ctrl+Maj+P : drag, snap, cumul
> mosaïque, position persistée), curseurs assainis (TTL 5 s, watchdog,
> masquage global) et recalage de l'état audio moteur après reload. Le **PIP
> système natif** est livré (§2.2) : fenêtre always-on-top redimensionnable,
> position/taille persistées, double-clic de taille, retour à Sion, son et
> pointeur. Le chemin direct I420 → BGRA → texture GL/GDK du lecteur
> principal est implémenté et affiche bien le direct sous Wayland. La surface est
> bornée aux rectangles vidéo, possède une région d'entrée vide et le runtime
> WRY crée son `GtkOverlay` avant la WebView : les entrées traversent bien la
> surface, mais la composition du même toplevel ralentit encore WebKit pendant
> un partage (mesure : ~38 % d'un cœur côté `WebKitWebProcess`). La sortie de
> la vidéo vers une `wl_subsurface` Wayland / fenêtre enfant X11 est le blocage
> performance courant ; état de reprise détaillé dans
> `docs/native-video-surface-handoff.md`.
> Le renderer DMA-BUF accéléré de WebKitGTK reste le défaut : le repli logiciel
> mesuré à ~95 % d'un cœur au repos n'est activé qu'après un crash GPU détecté
> ou via `SION_NATIVE_VIDEO_SOFTWARE_COMPOSITING=1`. La zone GTK reste non
> mappée tant qu'aucun partage n'est visible, afin d'éviter un repaint à 60 Hz.
> La surface Linux est désormais
> active par défaut (opt-out diagnostic `SION_DISABLE_NATIVE_VIDEO_SURFACE=1`).
> Une surface Windows intégrée est également livrée : un HWND enfant par zone
> visible, peinture BGRA directe par GDI, géométrie/DPI suivis et hit-test
> traversant vers WebView2. Le PIP système consomme
> déjà les mêmes frames BGRA sans recompression. Le socle GTK repose sur Tauri 2.11.5,
> retrait complet du fork CEF et correctif local ciblé de `tauri-runtime-wry`
> 2.11.4 pour accepter une WebView imbriquée dans un `GtkOverlay`.
> ✅ **Chantier 3, phase 1** : tokenisation complète — aucune couleur en dur
> hors « Matrix » et habillages posés sur le média (constants nommées),
> `utils/themeColor` pour les canvas, et **garde anti-hex en test**
> (`services/themeGuard.test.ts` : échappatoires `themeColor(…, "#repli")` et
> marqueur `theme-exempt`).
> ✅ **Chantier 3, phases 2–3** : `themeStore` persisté + `applyTheme` appliqué
> avant le premier rendu (aucun flash), section **Apparence** dans les Réglages
> (vignettes, « Sion Dark » / **« Sion Light »** / « AMOLED », suppression) — et l'**import/export
> JSON** de la phase 5 est livré au passage.
> ✅ **Stabilité locale** : état de fenêtre restauré après initialisation WRY
> et sauvegardé en continu, `sion-settings` versionné avec migration v0→v1,
> puis `session.json` écrit par remplacement atomique durable en mode privé.
> Le store crypto Matrix est isolé dans une IndexedDB Sion versionnée : la
> base SDK historique qui bouclait dans WASM/WebKitGTK n'est plus ouverte et
> un timeout ne déclenche plus une seconde initialisation concurrente.
> ⏳ **Restent** — Chantier 1 : presets exportables/importables, mode Arrange
> (Ctrl+Shift+L) et finitions container queries du dock bas. Chantier 3 :
> revue visuelle exhaustive de Sion Light, accent seed (phase 4), fin de la phase 5 (préview
> au survol, sync Matrix `com.sion.theme`, garde de contraste WCAG). Chantier 2 :
> validation prolongée des transitions/DPI sous Linux et validation sur une
> vraie machine Windows (dont curseurs/contrôles superposés), puis retrait du
> fallback JPEG/SVF1 lorsque la parité multi-plateforme sera acquise.

---

## 0. État des lieux (constats vérifiés dans le code)

| Sujet | Constat | Fichier |
|---|---|---|
| Layout | store v3 migré, sidebar trois états, docks droite/bas, onglets, panneaux flottants et presets | `useLayoutStore.ts`, `DockZone.tsx`, `FloatingPanels.tsx` |
| Lecteur natif | Linux : I420 → BGRA → texture GL/GDK fonctionnel sous Wayland, mais isolation hors du toplevel WebKit encore à faire pour supprimer le lag ; Windows : I420 → BGRA → HWND/GDI sans passage JS. Surface active par défaut, opt-out diagnostic `SION_DISABLE_NATIVE_VIDEO_SURFACE=1` | `main.rs`, `native_video_surface.rs`, `voice_engine.rs`, `ScreenShareView.tsx` |
| PIP système | vraie fenêtre OS winit + softbuffer, always-on-top, redimensionnable, persistée et alimentée directement en BGRA | `src-tauri/src/pip_window.rs` |
| Fallback | JPEG/SVF1/WebSocket conservé uniquement lorsque la surface intégrée native n'est pas disponible | `native_video_transport.rs` |
| Cible restante | validation Windows réelle, transitions/DPI multi-écrans, parité des calques superposés et retrait définitif du fallback JPEG | voir §2.3 |
| Thèmes | tokenisation et garde anti-hex livrées ; thèmes Dark/Light/AMOLED, application au boot et import/export JSON livrés | `src/themes/`, `useThemeStore.ts` |

Point clé : ni le PIP système ni le lecteur intégré natif ne font traverser
les pixels dans WebKit. La WebView publie uniquement les rectangles visibles ; Rust garde une file
latest-wins par expéditeur et peint les frames directement.

---

## 1. Chantier 1 — Panneaux redimensionnables / pliables

### 1.1 Principe

Deux briques nouvelles, utilisées partout ensuite :

**a. `useLayoutStore`** (zustand + `persist`, même pattern que `useSettingsStore`) :

```ts
interface LayoutState {
  sidebarWidth: number;          // 260 défaut, bornes [72, 400]
  sidebarMode: "full" | "rail" | "hidden";
  rightPanelWidth: number;       // 360 défaut, bornes [260, 520]
  rightPanelCollapsed: boolean;
  shareDock: "inline" | "floating" | "hidden";  // chantier 2
  shareFloating: { x: number; y: number; w: number; h: number } | null;
  // setters + preset: "chat" | "voice" | "stream"
}
```

Versionné (`version` + `migrate`) dès le départ, comme tout store persisté.

**b. `<ResizeHandle />`** — composant unique réutilisé par sidebar, dock droite
et carte PIP :

- `setPointerCapture` sur `pointerdown`, deltas en `pointermove`, relâche en
  `pointerup` (pas de listeners window orphelins).
- `role="separator"` + `aria-orientation` + `aria-valuenow/min/max` (pattern APG).
- Flèches ←/→ = ±8px, double-clic = reset défaut, Échap = annule le drag.
- Pendant le drag : `user-select: none` global + `pointer-events: none` sur les
  `<canvas>`/`<video>` (sinon WebKitGTK avale les moves au-dessus d'un canvas —
  le partage d'écran est justement un canvas).
- Zone de préhension invisible de 6-8px, highlight au survol.

### 1.2 Sidebar

| Mode | Largeur | Usage |
|---|---|---|
| `full` | 260 (drag 200→400) | défaut |
| `rail` | 72px | icônes de salons seules, tooltips |
| `hidden` | 0 | masquée, révélation au survol du bord (option) |

- Snap : si le drag descend sous ~160px, la sidebar s'accroche en `rail` ;
  re-drag vers la droite → `full` avec la dernière largeur mémorisée.
- Raccourci **Ctrl+B** pour cycle full/rail (à ajouter dans `useKeyboardShortcuts.ts`).
- Mobile : comportement inchangé (`isMobile` → 100%).

### 1.3 Dock droite (Member / Soundboard / Transcript)

- **Une largeur partagée** (`rightPanelWidth`) au lieu de 3 tailles en dur :
  changer de panneau ne re-dimensionne pas la colonne.
- Collapse par drag sous ~220px (ou bouton chevron) ; l'état se souvient du
  dernier panneau ouvert.
- `TranscriptPanel` lit déjà ses propres données : seul le conteneur bouge,
  aucun changement de logique.
- Conversation view (DM) : MemberPanel déjà masqué (`MemberPanel.tsx:80`), rien
  à faire.

### 1.4 Presets de layout (intégrés au futur `LayoutDoc`, cf. §1.6)

Trois presets, appliqués en un clic (menu du header ou palette de commandes) :

- **Chat** : sidebar full, dock à 360 sur Soundboard, partage inline.
- **Voix** : sidebar rail, dock fermée, partage en grand.
- **Streaming** : sidebar hidden, partage flottant, dock fermée.

### 1.5 Découpage

1. `ResizeHandle` + `useLayoutStore` + resize/collapse sidebar (+ Ctrl+B).
2. Dock droite : largeur unique + resize + collapse des 3 panneaux.
3. Snap, presets, double-clic reset, a11y complète.

### 1.6 Vision — « Layout editor » : panneaux dockables et flottants

L'évolution naturelle du chantier 1 : au lieu de zones figées, l'utilisateur
place lui-même ses panneaux. **Décision de design qui borne tout le chantier :
des zones (gauche / centre / droite / bas) avec panneaux dockables et
flottants — pas du placement libre façon canvas.** Le placement libre
multiplie par dix le travail d'adaptation des vues et casse la lisibilité ;
les zones, non.

**Inventaire réel des panneaux dockables** (vérifié dans le code) :

| Panneau | Contenu | Zones autorisées | Notes |
|---|---|---|---|
| Channels | ServerHeader + ChannelList + UserControls | gauche, droite | déjà une rail verticale ; jamais en bas |
| Chat | ChatHeader + MessageList + ChatInput + partage inline | **centre épinglé** | flexible par nature, jamais déplacé |
| Members | `MemberPanel.tsx` | gauche, droite, bas | |
| Soundboard | onglets Sons / Voix / Membres (`VoicePanel` inclus) | gauche, droite, bas | |
| Transcript | `TranscriptPanel.tsx` | gauche, droite, bas | excellent candidat au dock bas (lecture pleine largeur) |
| Flottants (phase 3) | n'importe lequel sauf Chat + la carte PIP | — | même primitive que §2.1 |

Opportunité au passage : le Soundboard a déjà un onglet « membres » qui doublonne
avec `MemberPanel`. L'éditeur est le bon moment pour consolider — une seule
liste de membres, plaçable une fois.

**Modèle de données** (remplace/complète `useLayoutStore`) :

```ts
type PanelId = "channels" | "members" | "soundboard" | "transcript";
interface LayoutDoc {
  version: 1;
  zones: {
    left:  { panels: PanelId[]; size: number; collapsed: boolean };
    right: { panels: PanelId[]; size: number; collapsed: boolean };
    bottom:{ panels: PanelId[]; size: number; collapsed: boolean };
  };
  floating: Record<string, FloatingPanelState>;      // même type que le PIP (§2.1)
  presets?: Record<string, Omit<LayoutDoc, "presets">>;
}
```

- Plusieurs panneaux dans une zone = **onglets** de zone (TabBar façon VS Code,
  style M3, tokens).
- Registry par panneau : `{ titleKey, icon, allowedZones, minWidth, minHeight,
  canFloat }`. **`allowedZones` est LE garde-fou** qui limite le travail
  d'adaptation (voir juste après).
- Garde-fous : une seule instance par panneau, Chat toujours présent, bouton
  « Réinitialiser le layout », menu « Panneaux » pour rouvrir un panneau masqué.

**« Il faudra peut-être adapter les vues » — oui, et voici la vraie réponse** :

1. `allowedZones` stricts : la Sidebar reste verticale, le Chat flexible.
   Ça élimine la majorité des cas tordus avant même d'écrire du CSS.
2. **Container queries Tailwind 4** — l'outil exact pour ce problème, et il est
   déjà dans ton install (tailwindcss 4.3, `@container` dans le core) : chaque
   zone devient un conteneur, un composant s'écrit relatif à la largeur **de sa
   zone** (`@md:flex`, `@lg:grid-cols-2`) au lieu de celle de la fenêtre.
   Zéro dépendance à ajouter.
3. `useZoneSize` (ResizeObserver, ~20 lignes) pour les décisions JS (libellés,
   disposition des rangées).
4. Constat encourageant sur l'existant — le gros du travail est déjà fait :
   - Soundboard : `repeat(auto-fill, minmax(150px, 1fr))`
     (`SoundboardPanel.tsx:526`) → **s'adapte déjà seul** à n'importe quelle
     largeur et hauteur.
   - Members / Transcript : listes verticales → adaptation triviale. En bas,
     Members passe en rangée d'avatars (~120px) et Transcript gagne un
     `max-width` de lecture.
   - ChatHeader : masquer les libellés sous un seuil (icônes + tooltips déjà
     là).
   - Estimation honnête des finitions : ~2-3 jours cumulés, étalables au fil
     des panneaux — pas des semaines, à condition de tenir `allowedZones`.

**Drag & drop** : pointer events uniquement (jamais HTML5 DnD, fragile sous
WebKitGTK). Mode « Arrange » (Ctrl+Shift+L) : les zones se matérialisent en
strips, on drag le header du panneau, le drop insère (position selon le
curseur dans la zone), ✕ masque, Échap annule.

**Deux primitives distinctes** : les panneaux et le PIP interne partagent la
carte flottante React (drag, resize, snap, persistance). Le PIP système est une
fenêtre Rust séparée ; il ne faut pas transformer les panneaux ordinaires en
fenêtres OS ni coupler leur cycle de vie au moteur vidéo.

**Libs vs maison** (compat React 19 vérifiée sur npm) :

| Lib | Version | React 19 | Adéquation |
|---|---|---|---|
| flexlayout-react | 0.10.8 | ✅ peer `^18 \|\| ^19` | modèle JSON, tabs + floating ; impose son DOM/CSS (re-thémer sur les tokens M3, i18n via props) |
| dockview-react | 8.3.1 | ✅ peer `16 → 19` | très VS Code, groupes/tabs/floating intégrés ; même dette d'intégration |
| react-mosaic | 7.1.0 | ✅ peer `16 - 19` | tiling pur sans onglets → peu adapté au chat épinglé |

Recommandation : **maison** d'abord — le modèle de zones tient en ~200 lignes,
et `ResizeHandle` (§1.1) et la carte flottante (§2.1) sont déjà des briques du
plan. Une lib apporte surtout ce qu'on a déjà et impose son DOM au milieu du
Tailwind/M3 (thème + i18n à recâbler). Spike `flexlayout-react` uniquement si
le dock bas multi-onglets devient central.

**Découpage** :

1. ✅ Zones resizable (§1.1-1.5) — le socle. Presets (§1.4) livrés avec.
2. ✅ Éditeur de zones : zones droite/bas + onglets + déplacement par menu **et
   par drag & drop** (pointer events, bande « Déposer ici ») + persistance +
   reset.
3. ✅ Flottants : détacher un panneau en carte (glisser, resize, rattacher,
   position/taille persistées) — même primitive que la carte PIP, plafond de
   2 cartes.
4. Restent : presets **exportables/importables**, mode Arrange (Ctrl+Shift+L —
   moins utile maintenant que les onglets se glissent) et finitions container
   queries au fil des panneaux (~3-5 j, étalable).

Ce qu'on ne fait **pas** : placement libre (canvas), sidebar horizontale,
multi-instances d'un même panneau, éditeur sur mobile (desktop-only).

---

## 2. Chantier 2 — Lecteur natif et PIP système du partage d'écran

### 2.1 Expérience de lecture — ✅ livrée, rendu natif Linux en validation

La vue en ligne, le plein écran, la mosaïque multi-partages et la carte
flottante interne sont fonctionnels. Les contrôles audio sont propres à chaque
partage et les curseurs restent ciblés sur le bon expéditeur. La carte interne
conserve sa position et sa taille via `useLayoutStore.shareFloating` ;
**Ctrl+Shift+P** la bascule en ligne/flottante.

Sous Linux, `spawn_video_pump` réduit la frame I420 décodée par libwebrtc à la
plus grande surface native visible, la convertit en BGRA via libyuv et la
dépose dans une file latest-wins. Une `GtkDrawingArea` compose la dernière
frame via une texture GL et `gdk_cairo_draw_from_gl` aux rectangles DOM de la
vue simple, de la mosaïque ou de la carte flottante ; Cairo reste le repli et
peint les curseurs. Aucun pixel ne traverse l'IPC ; le canvas WebKit est un
placeholder de géométrie et d'interactions uniquement. Son suivi est cadencé à
4 Hz plutôt que par une boucle `requestAnimationFrame` permanente.

### 2.2 PIP système natif — ✅ livré

`src-tauri/src/pip_window.rs` fournit une vraie fenêtre OS sans décoration,
always-on-top et indépendante de la webview :

- fenêtre winit + softbuffer, préchauffée au lancement ; X11/XWayland sous
  Linux pour garantir l'always-on-top, backend natif sous Windows ;
- glisser pour déplacer, redimensionnement libre par les bords, bornes
  240×135 → 1920×1080 et double-clic pour basculer le preset 768×432 ;
- position et taille persistées dans `pip-state.json`, avec rappel au coin
  proche lors de la restauration ;
- boutons natifs retour à Sion, son et pointeur ; clic droit ou Échap pour
  fermer ; fermeture automatique lorsque le partage prend fin ;
- lorsque ce PIP est ouvert, il reçoit directement le BGRA de libyuv et le
  blitte dans softbuffer : aucun encodage/décodage JPEG.

Le bouton retour appelle bien `show`/`unminimize`/`set_focus`. Sous Wayland,
le compositeur peut refuser l'activation sans jeton utilisateur, car le PIP
always-on-top vit sous XWayland ; dans ce cas Sion demande l'attention. Cette
limitation du protocole n'empêche ni l'affichage ni les autres contrôles du
PIP. Le Document PiP WebKit n'est plus un objectif : la fenêtre native couvre
déjà le besoin de PIP système.

### 2.3 Lecteur principal entièrement natif — 🟡 pixels natifs, isolation du compositeur en cours

**Socle livré (15/09/2026)** : le pin Git Tauri hérité de CEF a été retiré.
Le client utilise les crates Tauri 2 stables (`tauri` 2.11.5,
`tauri-runtime-wry` 2.11.4). Seul le runtime WRY est vendorié : son
gestionnaire Linux retrouve maintenant la vraie `GtkWindow` dans les ancêtres
de la WebView au lieu de supposer la hiérarchie fixe
`WebView → GtkBox → GtkWindow`. Cela supprime le crash GTK lors de l'ajout d'un
`GtkOverlay` tout en conservant le redimensionnement souris et tactile des
fenêtres sans décorations. Le patch et sa procédure de retrait sont documentés
dans `src-tauri/vendor/tauri-runtime-wry/SION_PATCH.md`.

**Implémentation validée en direct (15/09/2026)** : le runtime WRY crée un
`GtkOverlay` avant la WebView. `native_video_surface.rs` y installe une
`GtkDrawingArea` bornée à l'union des rectangles fournis par le front, avec une
région d'entrée native vide. Elle conserve uniquement la dernière frame BGRA
par expéditeur et la charge dans une texture GL composée par GDK, sans bloquer
les clics du DOM. Le repli Cairo reste disponible si le contexte GL ou
l'upload BGRA ne sont pas supportés. Le moteur contourne alors complètement
`encode_jpeg_rgba` et `native_video_transport`. Le PIP système partage ce
chemin BGRA direct via softbuffer.

Les curseurs des autres viewers et leurs ondes de clic sont peints dans le
même Cairo (`draw_viewer_cursors`) : en mode natif le calque DOM est occlu
par la peinture GTK, c'est désormais le seul chemin où les voir. Le filtre
« pointe un partage affiché par cette fenêtre » est fait en Rust
(`forward_cursor_to_viewer_surface`), même couleur par identité que l'overlay
du partageur (`cursor_overlay::draw::identity_color_rgba8`), même TTL 5 s,
même plafond d'ondes, latest-wins partout.

Les essais interactifs ont révélé puis fermé deux défauts Wayland distincts :
une surface overlay plein écran interceptait toutes les entrées, puis le
renderer DMA-BUF de WebKitGTK 2.52 conservait visuellement la première texture
alors que les empreintes BGRA et les callbacks Cairo changeaient. La surface
est désormais bornée et input-transparent. Le contournement
`WEBKIT_DISABLE_DMABUF_RENDERER=1` avait débloqué la texture mais saturait
WebKit au repos ; il reste donc limité au repli de crash NVIDIA et au diagnostic
explicite `SION_NATIVE_VIDEO_SOFTWARE_COMPOSITING=1`. Deux captures espacées ont
confirmé l'orientation et 8,6 % de pixels différents dans la zone vidéo. La
surface native est active par défaut depuis le 16/09 ;
`SION_DISABLE_NATIVE_VIDEO_SURFACE=1` force le fallback pour le diagnostic.

**Blocage performance constaté le 16/09/2026** : même sans aucun pixel, Blob
ou canvas vidéo dans JavaScript, le `GtkGLArea` reste composé dans le même
toplevel GTK que WebKit. Avec un partage actif, `sion-client` consomme environ
52 % d'un cœur et `WebKitWebProcess` environ 38 % ; les clics et changements
d'état deviennent visiblement tardifs. Le prochain jalon est donc une vraie
surface enfant indépendante (`wl_subsurface` sous Wayland, fenêtre enfant X11
sous X11/XWayland), avec le backend GTK actuel en repli. Le diagnostic, les
essais annulés et le plan de reprise sont consignés dans
[`native-video-surface-handoff.md`](native-video-surface-handoff.md).

**Windows (16/09/2026)** : WebView2 publie les mêmes rectangles CSS et Rust
crée un HWND enfant borné par rectangle, converti en pixels physiques avec le
facteur DPI de la fenêtre. La dernière frame BGRA est peinte directement par
`StretchDIBits` (letterbox inclus), sans JPEG, Blob ni canvas. `WM_NCHITTEST`
retourne `HTTRANSPARENT` afin que les interactions atteignent la WebView. Le
code passe le contrôle croisé Rust jusqu'au build des dépendances natives ; la
validation visuelle/perf sur une vraie session Windows reste un critère de
sortie avant suppression du fallback.

Critères de sortie :

1. plus d'appel à `encode_jpeg_rgba` dans le chemin des partages reçus ;
2. plus de WebSocket `native_video_transport` pour transporter les pixels ;
3. plus de `Blob`, `createImageBitmap`, `Image` ou peinture canvas pour le
   média dans `ScreenShareView` ;
4. une seule source latest-wins par expéditeur, partagée entre les surfaces
   visibles sans redécodage ni file non bornée ;
5. parité fonctionnelle : sélection multi-partages, mosaïque, plein écran,
   carte flottante, audio, pointeurs, fin de piste et reconnexion ;
6. nettoyage déterministe de chaque surface et frame à la fermeture, au
   changement de partage et à la déconnexion ;
7. validation Linux Wayland/X11 et Windows, avec mesures réception→pixels,
   cadence, CPU, RSS/PSS et test d'arrêt/reprise prolongé.

Les critères média 1 à 4 et le nettoyage déterministe sont validés sur Linux.
L'affichage direct fonctionne, mais la fluidité globale n'est pas encore un
critère acquis tant que la surface GTK réveille la composition WebKit. La
surface média Windows est codée ; restent sa validation réelle, les
contrôles/curseurs superposés, les transitions prolongées et le DPI
multi-écrans. Le pont JPEG/SVF1 demeure uniquement comme fallback de sûreté
jusqu'à cette validation.

## 3. Chantier 3 — Thèmes

### 3.1 Pourquoi c'est réaliste (et pas un chantier d'un an)

Ton app a déjà tout ce qu'il faut : **41 tokens `--color-*`** dans le bloc
`@theme` de `index.css`. Tailwind 4 compile les utilitaires en
`var(--color-surface-container-low)` etc. → **changer de thème = réécrire des
valeurs de custom properties à l'exécution**, sans rebuild ni refonte CSS.

C'est exactement l'approche Material Design 3 : des rôles (surface, on-surface,
primary-container…) et des palettes qui les remplissent. Le thème actuel
**est déjà** une palette M3 dark ; on rend cette indirection dynamique.

### 3.2 Architecture proposée

**Trois axes indépendants** :

1. **Mode** : `dark` / `light` → synchro `color-scheme` (WebKitGTK en dépend
   pour les selects/scrollbars natifs, cf. commentaire `index.css:330-348`).
2. **Palette** : le thème lui-même (« Sion Dark », « Sion Light », « AMOLED »,
   « Nord »…).
3. **Accent** (optionnel, phase ultérieure) : une couleur *seed* d'où l'on
   dérive `primary`, `primary-container`, `on-primary*`.

**Application runtime** — un seul point d'entrée :

```ts
// themeService.ts
function applyTheme(theme: Theme, mode: ThemeMode) {
  const t = resolve(theme, mode);            // ThemeTokenValues typé
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) {
    root.style.setProperty(`--color-${k}`, v);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = mode;
}
```

- Appelé au boot **avant le premier paint** (côté `main.tsx`/`index.html` :
  lire un mini-subset en `localStorage` et inliner le thème pour éviter le
  flash blanc/bleu au démarrage — même souci que la splash actuelle).
- `themeStore` (zustand persist) : `themeId`, `mode`, `accent`, `customThemes[]`.
- Sync de la fenêtre Tauri (`appWindow.setTheme`) pour la barre de titre
  Windows ; sous Linux GTK on reste sur `color-scheme`.

**Format d'un thème** (aussi le format d'échange communautaire, si tu en veux) :

```json
{
  "id": "sion-dark",
  "name": "Sion Dark",
  "mode": "dark",
  "tokens": { "surface": "#111318", "primary": "#a8c7fa", "…": "…" }
}
```

Whitelist stricte de clés = les 41 tokens (+ 4-6 tokens supplémentaires pour
ombres/états). Jamais de CSS arbitraire dans un thème importé ; les valeurs
validées comme couleurs CSS pures.

### 3.3 Phase 1 obligatoire : la tokenisation complète

Avant de faire des thèmes, finir l'audit — **zéro changement visuel** :

- 12 hex en dur hors `index.css` :
  `UserControls.tsx` (1), `VerificationBanner.tsx` (3), `Message.tsx` (4),
  `TranscriptPanel.tsx` (1), `AudioPreview.tsx` (1), `AudioTrimmer.tsx` (2).
- Dans `index.css` : `select option { background: #1f1f24 }`, le chevron SVG
  en data-URL (`stroke='%23c9c9d0'` → à générer depuis un token), les
  `rgba(0,0,0,…)` d'ombres et le `speaking-glow` `rgba(125,220,135,…)`.
- Ajouter 3-6 tokens de plus : `--shadow-*`, `--color-glow` (parler), pour
  couvrir ces cas proprement.
- Vérifier les endroits qui supposent « fond sombre » (bordures claires,
  `box-shadow` noirs) — c'est la que se cache la vraie dette d'un thème clair.

✅ L'acquis est verrouillé par `src/services/themeGuard.test.ts` : tout nouveau
`#hex` sous `src/` (hors `src/themes/`, qui EST le thème) fait échouer la suite
de tests — sauf les deux échappatoires documentées, le repli de
`themeColor("--token", "#repli")` et la ligne marquée `theme-exempt`.

### 3.4 Phases

| Phase | Contenu | Risque |
|---|---|---|
| ✅ 1 | Tokenisation complète (§3.3) + garde anti-hex (`services/themeGuard.test.ts`) | très faible |
| ✅ 2 | `themeStore` + `applyTheme` + section **Apparence** dans SettingsPanel + « Sion Dark » (actuel) + « AMOLED » | faible |
| ✅ 3 | « Sion Light » — palette complète claire livrée ; repassage visuel exhaustif encore à valider | moyen |
| 4 | Accent seed (génération de palette type Material You, ~150 l. de HCT simplifié ou vendor `material-color-utilities`) | moyen |
| 5 | ✅ Import/export JSON (livré avec la phase 2 — thèmes partiels acceptés, `custom-` rétabli au re-import) — reste : préview au survol + (option) sync Matrix `com.sion.theme` en account data → le thème suit le compte sur tous les appareils | faible |

**Apparence dans SettingsPanel** : grille de vignettes (aperçu 3 couleurs :
surface / primary / texte), toggle dark/light, picker accent, bouton « importer
un thème », « réinitialiser ».

### 3.5 Garde-fous

- **Contraste** : vérifier WCAG AA (≥ 4.5:1 sur les paires texte/fond
  principales) et afficher un warning si un thème importé échoue — l'utilisateur
  reste maître, mais informé.
- **Thème au boot** : sous-ensemble minimal en `localStorage` appliqué avant
  React (éviter le flash au lancement, surtout en mode clair).
- Le thème ne touche **pas** les pixels du partage ni les couleurs des
  curseurs distants dérivées de l'identité. Les contrôles placés au-dessus de
  la surface native continuent, eux, d'utiliser les tokens du thème.

---

## 4. Ordre de réalisation conseillé pour la 2.0.0 finale

1. 🚧 **Parité lecteur natif** (§2.3) — valider toutes les transitions Linux,
   porter la surface intégrée sous Windows, puis supprimer le fallback JPEG.
2. ⏳ **Finitions layout** (§1.6) — presets exportables/importables, décision
   sur le mode Arrange et container queries du dock bas.
3. ⏳ **Thème Sion Light** (§3.4, phase 3) avec audit visuel et contraste WCAG.
4. ⏳ **Accent seed** (§3.4, phase 4).
5. ⏳ **Finitions thèmes** (§3.4, phase 5) — aperçu au survol et décision sur
   la synchronisation Matrix `com.sion.theme`.

Le socle layout, le PIP interne, le PIP système natif, la tokenisation, Dark,
AMOLED et l'import/export JSON sont déjà livrés ; ils ne sont plus des étapes
à planifier.

## 5. Vérifications transverses

- `bun run test` / `lint` / `build` à chaque étape (stores et `applyTheme` se
  testent en vitest sans DOM lourd).
- Stores persistés : ajouter `version` + `migrate` (les utilisateurs alpha ont
  déjà un `localStorage` rempli) — vaut aussi pour `LayoutDoc`, qui doit
  survivre aux ajouts/retraits de panneaux sans perdre le layout.
- Lecteur natif : tester les changements de géométrie pendant un drag/resize,
  le passage inline ↔ flottant ↔ plein écran ↔ PIP système, la mosaïque et les
  changements de moniteur/DPI sans flash noir ni surface orpheline.
- Transport vidéo : le runtime Linux doit journaliser `flux direct GTK ...
  BGRA (sans JPEG/WebSocket)` et ne plus produire de statistiques d'encodage
  JPEG ; profiler encore une source 1440p/60 avant suppression du fallback.
- PIP système : garder un test fenêtré opt-in en plus des tests purs de rendu ;
  vérifier always-on-top, restauration position/taille, son, pointeur, retour
  à Sion et fermeture automatique sur Linux et Windows.
- Drag/drop de l'éditeur : pointer events uniquement, jamais HTML5 DnD sous
  WebKitGTK.
- Container queries : valider tôt le rendu de Members et Transcript en **dock
  bas** (rangée d'avatars, max-width de lecture) — c'est le cas d'usage le plus
  éloigné du design actuel.
- Mobile : tout ce qui précède est desktop-only (`isMobile`), ne pas régresser
  les vues tactiles.
