# Roadmap 2.0.0 — Layout modulable, PIP, Thèmes

Proposition d'architecture pour la 2.0.0 finale, basée sur l'état réel du code
au sortir de 2.0.0-alpha.1.

> **État d'avancement (11/09/2026, soir)** —
> ✅ **Chantier 1 (layout)** : socle complet — `useLayoutStore` persisté (v3 +
> migrations), `ResizeHandle` double axe, sidebar 200→400 px / rail 72 px /
> **masquée** (Ctrl+B cycle les trois, poignée de révélation sur le bord),
> dock à **deux zones redimensionnables** (droite 220→520, bas 140→520) avec
> **onglets**, panneaux déplaçables **par menu et par glisser-déposer**, et
> **détachables en cartes flottantes** (glisser, resize, rattacher, position
> et taille persistées) ; `resetLayout`, **presets Chat / Voix / Streaming**
> dans l'en-tête du salon. Bonus : mini-avatars d'occupants (parole/son/AFK/
> micro) + carte de survol complète (rôles, réseau, clic droit).
> ✅ **Chantier 2 (partage)** : hauteur réglable persistée, barre d'onglets
> navigateur (son + volume + plein écran), **mosaïque** (tuiles multi-partages,
> son et curseurs par tuile), **PIP interne** (Ctrl+Maj+P : drag, snap, cumul
> mosaïque, position persistée), curseurs assainis (TTL 5 s, watchdog,
> masquage global), recalage de l'état audio moteur après reload, et **PIP
> natif** (§2.2, v1) — fenêtre OS always-on-top (winit + softbuffer) branchée
> sur les JPEG déjà côté Rust : bouton dans la barre du partage, glisser pour
> déplacer, clic droit ou Échap pour fermer, se ferme avec le partage — et
> **mini-lecteur flottant** des vidéos du chat (§2.4).
> ✅ **Chantier 3, phase 1** : tokenisation complète — aucune couleur en dur
> hors « Matrix » et habillages posés sur le média (constants nommées),
> `utils/themeColor` pour les canvas, et **garde anti-hex en test**
> (`services/themeGuard.test.ts` : échappatoires `themeColor(…, "#repli")` et
> marqueur `theme-exempt`).
> ✅ **Chantier 3, phase 2** : `themeStore` persisté + `applyTheme` appliqué
> avant le premier rendu (aucun flash), section **Apparence** dans les Réglages
> (vignettes, « Sion Dark » / « AMOLED », suppression) — et l'**import/export
> JSON** de la phase 5 est livré au passage.
> ⏳ **Restent** — Chantier 1 : presets exportables/importables, mode Arrange
> (Ctrl+Shift+L) et finitions container queries du dock bas. Chantier 3 :
> « Sion Light » (phase 3), accent seed (phase 4), fin de la phase 5 (préview
> au survol, sync Matrix `com.sion.theme`, garde de contraste WCAG). Chantier 2 :
> ne restent que les finitions du PIP natif (position/taille persistées entre
> sessions, coin d'ancrage, double-clic → app au premier plan) — le PiP OS est
> écarté, WebKitGTK ne l'expose pas (spike du 11/09).

---

## 0. État des lieux (constats vérifiés dans le code)

| Sujet | Constat | Fichier |
|---|---|---|
| Layout racine | `app-root` = flex ; Sidebar + MainArea | `src/App.tsx:357` |
| Sidebar | largeur **260px en dur** (inline style), pas de collapse | `src/components/layout/Sidebar.tsx:16` |
| Panneaux droits | MemberPanel **240px** / Soundboard **360px** / Transcript **300px**, largeurs en dur | `MemberPanel.tsx:92`, `SoundboardPanel.tsx:335`, `TranscriptPanel.tsx:298` |
| Toggles panneaux | `showMemberPanel` / `showSoundboardPanel` mutuellement exclusifs, pas de notion de taille | `src/stores/useAppStore.ts:54,269-277` |
| Partage d'écran | Rust capture → JPEG WebSocket → **`<canvas>` peint hors React**, jamais d'`<iframe>` | `ScreenShareView.tsx` (805 l.) |
| Redimensionnement canvas | le paint lit `canvas.clientWidth` à chaque frame (sizing DPR + `imageSmoothingQuality`) → **s'adapte déjà à n'importe quelle taille** | `ScreenShareView.tsx:294-313` |
| Fenêtre native | précédent existant : overlay curseurs **winit + softbuffer**, transparent, click-through, always-on-top, X11/Wayland gérés | `src-tauri/src/cursor_overlay.rs` |
| Transport vidéo Rust | frames vidéo déjà côté Rust avant envoi webview | `src-tauri/src/native_video_transport.rs` |
| Thèmes | Tailwind 4, **41 tokens `--color-*`** dans `@theme` (M3 dark) → custom properties runtime | `src/index.css:3-64` |
| Couleurs en dur | 12 hex dans les composants + `color-scheme: dark`, `select option #1f1f24`, chevron SVG `%23c9c9d0`, `rgba()` d'ombres/glows | voir §3.4 |
| Persistance | pattern zustand `persist` déjà utilisé partout | `useSettingsStore.ts:1-2` |

Point clé : les trois chantiers partagent **une même primitive** — un panneau
flottant/redimensionnable — et la tokenisation déjà en place rend les thèmes
quasi gratuits en infrastructure.

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

**Une seule primitive flottante pour tout** : la carte du PIP (§2.1) — drag,
resize, snap, persistance — est le même objet que les panneaux flottants de
l'éditeur. On la construit une fois (à l'occasion du PIP), on la généralise
ensuite. Et le jour où le PIP natif (§2.2) existe, un panneau flottant peut
devenir une vraie fenêtre OS.

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

## 2. Chantier 2 — PIP du partage d'écran

Toujours pas d'iframe : le partage est un `<canvas>` alimenté en JPEG natif.
« Réduire » = un **mode d'affichage** du `ScreenShareView`, pas un changement
de technologie. Trois niveaux, à faire dans cet ordre.

### 2.1 Niveau 1 — PIP interne à l'app — ✅ livré

Une carte flottante **dans la webview**, au-dessus de tout :

- C'est le `ScreenShareView` rendu dans un conteneur `position: fixed` au lieu
  du slot inline de `MainArea.tsx:94`. Le canvas, les curseurs, l'audio et les
  contrôles suivent tels quels.
- Drag (via `ResizeHandle` + un `useDragMove`), resize, snap aux 4 coins avec
  marge, tailles S/M/L, opacité optionnelle quand non survolée.
- Le downscale est **déjà géré** : le paint lit `canvas.clientWidth` par frame
  et redimensionne la surface en DPR (`ScreenShareView.tsx:294-313`). Réduire à
  320×180 rend même le rendu moins cher.
- Règles d'affichage : visible même après changement de salon ; auto-passage en
  flottant quand l'utilisateur scrolle le chat ou ouvre un panneau (option
  « réduire automatiquement ») ; bouton « remettre inline » ; croix = masquer
  (le partage continue, réactivable depuis le header).
- Position/taille persistées dans `useLayoutStore.shareFloating`.
- Raccourci : **Ctrl+Shift+P** (basculer inline/flottant).

### 2.2 Niveau 2 — PIP natif always-on-top — ✅ livré (v1)

Implémenté dans `src-tauri/src/pip_window.rs` :

- Fenêtre winit sans décoration, `AlwaysOnTop`, **X11 forcé sous Linux**
  (Wayland ignore l'always-on-top pour un toplevel ordinaire) — mêmes choix
  que `cursor_overlay.rs`, même thread d'event loop dédié.
- Second consommateur branché dans `native_video_transport::broadcast()` :
  `pip_window::on_frame()` dépose le JPEG dans l'état partagé, la boucle le
  décode (`image`) à ~20 fps maximum et le blitte (letterbox) — **zéro
  passage par la webview, zéro décodage double**, comme prévu ici.
- Commandes `pip_native_open(sender)` / `pip_native_close` /
  `pip_native_status` ; bouton dédié dans la barre d'onglets du partage ;
  la fenêtre se ferme d'elle-même avec le partage (`on_share_removed`).
- Contrôles : glisser = déplacer (`drag_window`), clic droit ou Échap =
  fermer. Position mémorisée en mémoire de session.

Reste (finitions) : position/taille persistées entre sessions, coin d'ancrage
et tailles S/M/L, double-clic → ramener la fenêtre principale au premier plan.

**Backend d'affichage (13/09/2026)** — la fenêtre principale est repassée en
**Wayland natif par défaut** ; seul le couple PIP + overlay curseurs reste X11
(always-on-top impossible pour un toplevel Wayland ordinaire). Conséquence
assumée : le bouton **« retour à Sion »** ne peut plus relever la fenêtre
principale — un client X11 ne peut pas fournir de jeton `xdg_activation` — et
le compositeur se contente d'une demande d'attention (entrée qui clignote).
La sortie propre est **`xx-pip-v1`** (PiP en couche overlay) : implémenté par
KWin (MR 3612, Plasma 6.5) et Firefox (bug 1970372), mais **désactivé par
défaut** côté KWin (`KWIN_WAYLAND_SUPPORT_XX_PIP_V1=1`) et absent de Mutter.
À reprendre quand il s'active tout seul : un PiP Wayland fournit le geste
utilisateur nécessaire au jeton, que GTK3 sait déjà consommer
(`gdk_wayland_window_set_startup_id`). Opt-in X11 : `SION_FORCE_X11=1`.

### 2.3 Niveau 3 — PiP OS (Document PiP) — ❌ spike fait, non supporté ici

`canvas.captureStream()` → `<video>` caché → `requestPictureInPicture()`.
Ça donnerait le **faux-PiP flottant du système** gratuitement… quand la
plateforme le supporte.

**Spike fait (11/09/2026)** : sonde exécutée dans le WebKitGTK de Sion
(UA `AppleWebKit/605.1.15`, Version/60.5) → `document.pictureInPictureEnabled`
absent et `HTMLVideoElement.prototype.requestPictureInPicture` **undefined** ;
seul `captureStream` existe. Verdict : **pas de PiP OS sur Linux/WebKitGTK** —
le niveau 3 est mort ici, et c'est le PIP natif (§2.2) qui couvre le besoin
« au-dessus des autres apps ». À re-tester si WebView2 (Windows) est visé : le
support y est plausible.

### 2.4 Vidéos du chat — ✅ livré

Les vidéos de messages sont des `<video>` natifs. Le **mini-lecteur flottant**
reprend la lecture dans la même carte que le PIP du partage (drag par le
bandeau, snap aux coins, resize, position en mémoire de session) : bouton
« Mini-lecteur » sous chaque vidéo, `useMiniPlayerStore` non persisté (la
source est un objectURL qui meurt au reload), entrée à la position courante,
lecture dès les métadonnées chargées — on peut changer de salon ou scroller,
la vidéo continue.

---

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
| 3 | « Sion Light » — le vrai morceau : repassage visuel de chaque écran, contrastes, images, canvas | moyen |
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
- Le thème ne touche **pas** : couleurs des curseurs distants (dérivées par
  identité, `ScreenShareView.tsx:143`), ni le rendu du partage d'écran
  (pixels bruts).

---

## 4. Ordre de réalisation conseillé pour la 2.0.0 finale

1. **Socle layout** (chantier 1, §1.1-1.5) — valeur immédiate, risque faible,
   aucun couplage. Construit `ResizeHandle` + le store, réutilisés partout.
2. **Thèmes, phase 1** (§3.3) — petit, et évite que tout ce qui sera peint
   ensuite (PIP, éditeur, outils) le soit en dur.
3. **PIP interne** (chantier 2, niveau 1) — contient le prototype de la carte
   flottante, primitive partagée avec l'éditeur.
4. **Layout editor** (§1.6, étapes 2-4) — zones dockables, onglets, flottants
   généralisés, presets. Réutilise 1 et 3.
5. **Thèmes, phases 2-5** — Apparence, AMOLED, Light, accent, import/export.
6. **PIP natif / PiP OS** (chantier 2, niveaux 2-3) — seulement si le niveau 1
   montre que le « au-dessus des autres apps » manque.

Les cinq premières étapes sont indépendantes deux à deux (chaque étape livre un
état stable) : si la 2.0.0 finale doit sortir serrée, 1-2-3 portent déjà les
trois demandes (modulable, PIP, thèmes), et l'éditeur complet (§1.6) peut
glisser en 2.1 sans casser le modèle de données.

## 5. Vérifications transverses

- `bun run test` / `lint` / `build` à chaque étape (stores et `applyTheme` se
  testent en vitest sans DOM lourd).
- Stores persistés : ajouter `version` + `migrate` (les utilisateurs alpha ont
  déjà un `localStorage` rempli) — vaut aussi pour `LayoutDoc`, qui doit
  survivre aux ajouts/retraits de panneaux sans perdre le layout.
- WebKitGTK : tester le drag de panneaux **au-dessus du canvas de partage** dès
  le premier commit du chantier 1 — c'est le point de friction probable. Même
  vigilance pour le drag/drop de l'éditeur (pointer events, jamais HTML5 DnD).
- Container queries : valider tôt le rendu de Members et Transcript en **dock
  bas** (rangée d'avatars, max-width de lecture) — c'est le cas d'usage le plus
  éloigné du design actuel.
- Mobile : tout ce qui précède est desktop-only (`isMobile`), ne pas régresser
  les vues tactiles.
