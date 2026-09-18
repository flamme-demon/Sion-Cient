import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import {
  useLayoutStore,
  DOCK_ZONE_IDS,
  DOCK_SIDE_MIN_SIZE,
  DOCK_SIDE_MAX_SIZE,
  DOCK_SIDE_DEFAULT_SIZE,
  DOCK_BOTTOM_MIN_SIZE,
  DOCK_BOTTOM_MAX_SIZE,
  DOCK_BOTTOM_DEFAULT_SIZE,
  DOCK_TOP_MIN_SIZE,
  DOCK_TOP_MAX_SIZE,
  DOCK_TOP_DEFAULT_SIZE,
  type DockPanelId,
  type DockZoneId,
} from "../../stores/useLayoutStore";
import { ResizeHandle } from "./ResizeHandle";
import { DockZoneContext } from "./dockZoneContext";
import { BackgroundControls, PanelBackgroundLayer } from "./PanelBackground";
import { usePanelBackgroundStyle } from "../../services/panelBackground";
import { VoiceStatusPanel } from "../chat/VoiceStatusPanel";

// Blocs lourds chargés à la demande (perf mémoire, 2026-09-12) : le soundboard
// embarquait dans le chunk de démarrage tout son sous-graphe (panneau vocal,
// modal d'upload, trimballeur, hotkeys) alors qu'il n'est peint que si le
// bloc est docké ET le salon soundboard présent. Idem membres et
// transcription. Le chunk de boot ne garde que la coquille de la dock.
const MemberPanel = lazy(() =>
  import("../chat/MemberPanel").then((m) => ({ default: m.MemberPanel })),
);
const SoundboardPanel = lazy(() =>
  import("../chat/SoundboardPanel").then((m) => ({ default: m.SoundboardPanel })),
);
const PinnedPanel = lazy(() =>
  import("../chat/PinnedListPanel").then((m) => ({ default: m.PinnedListPanel })),
);
const TranscriptPanel = lazy(() =>
  import("../chat/TranscriptPanel").then((m) => ({ default: m.TranscriptPanel })),
);

/**
 * Une zone de la dock (roadmap §1.6) : à droite en colonne, en haut ou en bas
 * en bandeau. Elle porte la poignée de redimensionnement et **empile ses
 * panneaux** — pas d'onglets : les blocs vivent l'un sous l'autre, dans
 * l'ordre du store (`dockZones[zone].panels`). Celui qui a besoin d'une barre
 * fine (le bloc vocal) garde sa hauteur naturelle, les autres se partagent le
 * reste.
 *
 * Hors édition : aucun châssis, chaque panneau porte son propre en-tête. En
 * édition : une barre fine par bloc (⠿ nom ⋯ masquer) + un voile saisissable
 * n'importe où — on glisse le bloc vers une autre zone (le dépôt insère selon
 * la position du curseur) ou vers le cadre « Menu » pour le remettre à
 * l'origine. Pointer events uniquement (jamais HTML5 DnD — WebKitGTK).
 */
const PANEL_TITLE_KEYS: Record<DockPanelId, string> = {
  members: "members.title",
  soundboard: "soundboard.title",
  transcript: "transcript.title",
  voice: "layout.voicePanelTitle",
  pinned: "chat.pinnedList",
};

const PANEL_BODIES: Record<DockPanelId, ComponentType> = {
  members: MemberPanel,
  soundboard: SoundboardPanel,
  transcript: TranscriptPanel,
  voice: VoiceStatusPanel,
  pinned: PinnedPanel,
};

/** Part de hauteur : 0 = hauteur naturelle (une barre, comme le bloc vocal),
 *  1 = élastique (les blocs à contenu se partagent l'espace restant). */
const PANEL_FLEX: Record<DockPanelId, number> = {
  members: 1,
  soundboard: 1,
  transcript: 1,
  voice: 0,
  pinned: 1,
};

/** Cible de dépôt : une zone de la dock, ou « menu » (la carte d'origine du
 *  bloc, dans le menu latéral — seul le bloc voix y vit d'habitude). */
type DropTarget = DockZoneId | "menu";

/** Cible sous un point de l'écran (les conteneurs portent `data-dock-zone`). */
function zoneAtPoint(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  const holder = el?.closest?.("[data-dock-zone]") as HTMLElement | null;
  const value = holder?.dataset.dockZone;
  if (value === "top" || value === "right" || value === "bottom") return value;
  if (value === "menu") return "menu";
  return null;
}

/**
 * Panneau devant lequel insérer, d'après la position du pointeur dans la zone
 * visée : les zones empilent verticalement, seul Y compte. Au-dessus du milieu
 * d'un bloc → on se place avant lui ; sinon après tous.
 */
function insertBeforeAt(x: number, y: number, moving: DockPanelId): DockPanelId | null {
  const el = document.elementFromPoint(x, y);
  const zoneEl = el?.closest?.("[data-dock-zone]") as HTMLElement | null;
  if (!zoneEl) return null;
  const children = Array.from(zoneEl.querySelectorAll<HTMLElement>("[data-dock-panel]"));
  for (const child of children) {
    const id = child.dataset.dockPanel as DockPanelId | undefined;
    if (!id || id === moving) continue;
    const rect = child.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return id;
  }
  return null;
}

/**
 * Un panneau n'est affiché que si son contenu existe pour le contexte courant
 * (pas de membres en DM, pas de soundboard sans salon soundboard, pas de
 * transcription hors vocal). Le filtrage est fait au rendu : l'intention de
 * l'utilisateur (panneau ouvert, zone choisie) est conservée telle quelle.
 */
function useDockAvailability(): Record<DockPanelId, boolean> {
  const activeChannel = useAppStore((s) => s.activeChannel);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const hasSoundboard = useMatrixStore((s) => s.channels.some((c) => c.isSoundboard));
  const isDM = useMatrixStore((s) => s.channels.find((c) => c.id === activeChannel)?.isDM ?? false);
  return useMemo(
    () => ({ members: !!activeChannel && !isDM, soundboard: hasSoundboard, transcript: !!connectedVoice, voice: !!connectedVoice, pinned: !!activeChannel }),
    [activeChannel, isDM, hasSoundboard, connectedVoice],
  );
}

/** Menu d'un bloc : le déplacer vers une autre zone, le détacher, le fermer. */
function ZoneMenu({ panel, zone }: { panel: DockPanelId; zone: DockZoneId }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const itemStyle: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '7px 10px', borderRadius: 8, border: 'none',
    background: 'transparent', color: 'var(--color-on-surface)',
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
  };

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("layout.panelMenu", { defaultValue: "Bloc : déplacer ou fermer" })}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          border: 'none', background: open ? 'var(--color-surface-container-high)' : 'transparent',
          color: 'var(--color-on-surface-variant)', cursor: 'pointer',
          fontSize: 13, lineHeight: 1, padding: '2px 6px', borderRadius: 8,
        }}
      >⋯</button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40,
            minWidth: 190, padding: 6,
            background: 'var(--color-surface-container)',
            border: '1px solid var(--color-outline-variant)',
            borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          {DOCK_ZONE_IDS.filter((z) => z !== zone).map((z) => (
            <button
              key={z}
              role="menuitem"
              onClick={() => { useLayoutStore.getState().moveDockPanel(panel, z); setOpen(false); }}
              style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {z === "top"
                ? t("layout.moveToTop", { defaultValue: "Déplacer en haut" })
                : z === "right"
                  ? t("layout.moveToRight", { defaultValue: "Déplacer à droite" })
                  : t("layout.moveToBottom", { defaultValue: "Déplacer en bas" })}
            </button>
          ))}
          <button
            role="menuitem"
            onClick={() => { useLayoutStore.getState().floatDockPanel(panel); setOpen(false); }}
            style={itemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {t("layout.floatPanel", { defaultValue: "Détacher en fenêtre flottante" })}
          </button>
          {panel === "voice" && (
            <button
              role="menuitem"
              onClick={() => { useLayoutStore.getState().returnVoiceToMenu(); setOpen(false); }}
              style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {t("layout.voiceBackToMenu", { defaultValue: "Renvoyer dans le menu" })}
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => { useLayoutStore.getState().closeDockPanel(panel); setOpen(false); }}
            style={itemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {t("layout.closePanel", { defaultValue: "Fermer le bloc" })}
          </button>
        </div>
      )}
    </div>
  );
}

export function DockZone({ zone }: { zone: DockZoneId }) {
  const { t } = useTranslation();
  const zoneState = useLayoutStore((s) => s.dockZones[zone]);
  const setDockZoneSize = useLayoutStore((s) => s.setDockZoneSize);
  const setPanelDrag = useLayoutStore((s) => s.setPanelDrag);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragOverZone = useLayoutStore((s) => s.dragOverZone);
  const layoutEditing = useLayoutStore((s) => s.layoutEditing);
  const availability = useDockAvailability();
  const dragPointer = useRef<number | null>(null);

  // Fonds d'image des blocs — hooks appelés dans un ordre FIXE, avant tout
  // retour anticipé (un appel conditionnel ferait varier l'ordre des hooks).
  const blockBgs = {
    members: usePanelBackgroundStyle("members"),
    soundboard: usePanelBackgroundStyle("soundboard"),
    transcript: usePanelBackgroundStyle("transcript"),
    voice: usePanelBackgroundStyle("voice"),
    pinned: usePanelBackgroundStyle("pinned"),
  };

  // Échap annule un drag en cours (comme les poignées de resize).
  useEffect(() => {
    if (!draggingPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useLayoutStore.getState().setPanelDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draggingPanel]);

  const visible = zoneState.panels.filter((p) => availability[p]);
  const isRight = zone === "right";
  const isTop = zone === "top";
  const dropActive = dragOverZone === zone && !!draggingPanel;

  // Zone vide : cadre pointillé étiqueté en mode édition (la grille de
  // construction), bande de dépôt pendant un drag — sinon rien.
  if (visible.length === 0) {
    if (!layoutEditing && !draggingPanel) return null;
    const zoneLabel = isTop
      ? t("layout.zoneTop", { defaultValue: "Haut" })
      : isRight
        ? t("layout.zoneRight", { defaultValue: "Droite" })
        : t("layout.zoneBottom", { defaultValue: "Bas" });
    if (isRight) {
      return (
        <div
          data-dock-zone="right"
          style={{
            width: dropActive ? 150 : layoutEditing ? 110 : 84, flexShrink: 0, margin: 6, borderRadius: 12,
            border: '2px dashed var(--color-outline-variant)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
            color: 'var(--color-on-surface-variant)', fontSize: 11, textAlign: 'center',
            padding: 8, transition: 'width 120ms', lineHeight: 1.4,
          }}
        >
          {layoutEditing && <span style={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 10 }}>{zoneLabel}</span>}
          <span>{t("layout.dropHere", { defaultValue: "Déposer ici" })}</span>
        </div>
      );
    }
    return (
      <div
        data-dock-zone={zone}
        style={{
          height: dropActive ? 104 : layoutEditing ? 76 : 64, flexShrink: 0, margin: 6, borderRadius: 12,
          border: '2px dashed var(--color-outline-variant)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          color: 'var(--color-on-surface-variant)', fontSize: 11,
          transition: 'height 120ms',
        }}
      >
        {layoutEditing && <span style={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 10 }}>{zoneLabel}</span>}
        <span>{t("layout.dropHere", { defaultValue: "Déposer ici" })}</span>
      </div>
    );
  }

  const min = isRight ? DOCK_SIDE_MIN_SIZE : isTop ? DOCK_TOP_MIN_SIZE : DOCK_BOTTOM_MIN_SIZE;
  const max = isRight ? DOCK_SIDE_MAX_SIZE : isTop ? DOCK_TOP_MAX_SIZE : DOCK_BOTTOM_MAX_SIZE;
  const defaultSize = isRight ? DOCK_SIDE_DEFAULT_SIZE : isTop ? DOCK_TOP_DEFAULT_SIZE : DOCK_BOTTOM_DEFAULT_SIZE;

  const handle = (
    <ResizeHandle
      // Le bord INTÉRIEUR de la zone : gauche pour la colonne droite, bas pour
      // le bandeau haut, haut pour le bandeau bas.
      side={isRight ? "left" : isTop ? "bottom" : "top"}
      value={zoneState.size}
      min={min}
      max={max}
      onChange={(size) => setDockZoneSize(zone, size)}
      onReset={() => setDockZoneSize(zone, defaultSize)}
      label={t("layout.resizeDockZone", { defaultValue: "Redimensionner la zone — double-clic pour la taille par défaut" })}
    />
  );

  const shellStyle: React.CSSProperties = {
    background: 'var(--color-surface-container-low)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    flexShrink: 0,
    // Pendant un drag, la zone cible s'annonce (le survol l'intensifie).
    outline: draggingPanel ? `1px solid ${dropActive ? 'var(--color-primary)' : 'var(--color-outline-variant)'}` : 'none',
    outlineOffset: -1,
  };

  // ── Drag d'un bloc (depuis le voile d'édition) ───────────────────────────
  const beginPanelDrag = (e: React.PointerEvent, panel: DockPanelId) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragPointer.current = e.pointerId;
    setPanelDrag(panel);
  };
  const movePanelDrag = (e: React.PointerEvent, panel: DockPanelId) => {
    if (dragPointer.current !== e.pointerId) return;
    const over = zoneAtPoint(e.clientX, e.clientY);
    // « menu » ne s'illumine pas comme une zone : le cadre du menu s'annonce
    // tout seul (il n'existe QUE pendant un drag du bloc voix).
    const next = over === "menu" ? null : over;
    if (next !== dragOverZone) setPanelDrag(panel, next);
  };
  const endPanelDrag = (e: React.PointerEvent, panel: DockPanelId) => {
    if (dragPointer.current !== e.pointerId) return;
    dragPointer.current = null;
    const target = zoneAtPoint(e.clientX, e.clientY);
    if (target === "menu") {
      // Retour à l'origine (menu latéral) — seul le bloc voix y a sa place.
      if (panel === "voice") useLayoutStore.getState().returnVoiceToMenu();
    } else if (target) {
      // Zone (même la sienne : c'est ainsi qu'on réordonne) — insertion à la
      // position du curseur.
      useLayoutStore.getState().moveDockPanel(panel, target, insertBeforeAt(e.clientX, e.clientY, panel));
    }
    setPanelDrag(null);
  };

  // Les blocs de la zone, empilés dans l'ordre du store — pas d'onglets.
  const stack = (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {visible.map((p, i) => {
        const Body = PANEL_BODIES[p];
        const isBar = PANEL_FLEX[p] === 0;
        const isDragged = draggingPanel === p;
        return (
          <div
            key={p}
            data-dock-panel={p}
            style={{
              flex: isBar ? '0 0 auto' : '1 1 0',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              // Fond d'image éventuel du bloc (sous son contenu).
              ...(blockBgs[p] ?? {}),
              // Séparateur entre deux blocs empilés.
              borderTop: i > 0 ? '1px solid var(--color-outline-variant)' : undefined,
              opacity: isDragged ? 0.6 : 1,
            }}
          >
            <BackgroundControls scope={p} />
            {/* Mode « flou » : l'image vit dans ce calque, sous le contenu. */}
            <PanelBackgroundLayer scope={p} />
            {layoutEditing && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                padding: '2px 6px',
                background: 'var(--color-surface-container)',
                borderBottom: '1px solid var(--color-outline-variant)',
              }}>
                <span aria-hidden style={{ fontSize: 10, opacity: 0.7, color: 'var(--color-on-surface-variant)' }}>⠿</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t(PANEL_TITLE_KEYS[p])}
                </span>
                <ZoneMenu panel={p} zone={zone} />
                <button
                  type="button"
                  onClick={() => useLayoutStore.getState().closeDockPanel(p)}
                  title={t("layout.editHidePanel", { defaultValue: "Masquer ce bloc" })}
                  style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '2px 6px', borderRadius: 8 }}
                >✕</button>
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
              <DockZoneContext.Provider value={zone}>
                {/* Les blocs sont paresseux : le premier rendu peut suspendre
                    le temps de charger leur chunk (invisible : quasi
                    instantané en local). */}
                <Suspense fallback={null}>
                  <Body />
                </Suspense>
              </DockZoneContext.Provider>
              {/* Édition : le bloc se saisit N'IMPORTE OÙ (le contenu ne réagit
                  plus aux clics), on le dépose dans une zone. */}
              {layoutEditing && (
                <div
                  onPointerDown={(e) => beginPanelDrag(e, p)}
                  onPointerMove={(e) => movePanelDrag(e, p)}
                  onPointerUp={(e) => endPanelDrag(e, p)}
                  onPointerCancel={() => { dragPointer.current = null; setPanelDrag(null); }}
                  title={t("layout.editLayoutHint", { defaultValue: "Glissez les blocs dans la grille" })}
                  style={{
                    position: 'absolute', inset: 0, zIndex: 3, cursor: 'grab', touchAction: 'none',
                    outline: '2px solid var(--color-primary)', outlineOffset: -2, borderRadius: 6,
                    background: 'rgba(168, 199, 250, 0.08)',
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (isRight) {
    return (
      <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
        {handle}
        <aside data-dock-zone="right" style={{ ...shellStyle, width: zoneState.size, borderLeft: '1px solid var(--color-outline-variant)' }}>
          {stack}
        </aside>
      </div>
    );
  }

  // Bandeau haut : contenu puis poignée (le bord intérieur est en bas).
  if (isTop) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <section data-dock-zone="top" style={{ ...shellStyle, height: zoneState.size, borderBottom: '1px solid var(--color-outline-variant)' }}>
          {stack}
        </section>
        {handle}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {handle}
      <section data-dock-zone="bottom" style={{ ...shellStyle, height: zoneState.size, borderTop: '1px solid var(--color-outline-variant)' }}>
        {stack}
      </section>
    </div>
  );
}
