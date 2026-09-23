import { lazy, Suspense, useMemo, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import {
  useLayoutStore,
  FLOATING_PANEL_MIN_W,
  FLOATING_PANEL_MIN_H,
  type DockPanelId,
} from "../../stores/useLayoutStore";
import { ResizeHandle } from "./ResizeHandle";
import { VoiceStatusPanel } from "../chat/VoiceStatusPanel";

// Mêmes blocs paresseux que la dock (perf mémoire, 2026-09-12) : une carte
// flottante ne charge son contenu qu'au premier affichage.
const MemberPanel = lazy(() =>
  import("../chat/MemberPanel").then((m) => ({ default: m.MemberPanel })),
);
const SoundboardPanel = lazy(() =>
  import("../chat/SoundboardPanel").then((m) => ({ default: m.SoundboardPanel })),
);
const MemeboardPanel = lazy(() =>
  import("../chat/MemeboardPanel").then((m) => ({ default: m.MemeboardPanel })),
);
const PinnedPanel = lazy(() =>
  import("../chat/PinnedListPanel").then((m) => ({ default: m.PinnedListPanel })),
);
const TranscriptPanel = lazy(() =>
  import("../chat/TranscriptPanel").then((m) => ({ default: m.TranscriptPanel })),
);

/**
 * Panneaux détachés en cartes flottantes (roadmap §1.6, étape 3) — même
 * primitive que la carte PIP du partage : position fixe, drag par le bandeau
 * (snap aux coins à la dépose), resize par les poignées, position/taille
 * persistées dans `useLayoutStore.floatingPanels`.
 *
 * Le menu ⋮ des onglets détache ; le bandeau de la carte rattache ou ferme.
 * Position par défaut (x/y < 0 dans le store) : bas-droite, recalculée au
 * rendu — le store ne connaît pas la taille de la fenêtre.
 */
const PANEL_TITLE_KEYS: Record<DockPanelId, string> = {
  members: "members.title",
  soundboard: "soundboard.title",
  memeboard: "memeboard.title",
  transcript: "transcript.title",
  voice: "layout.voicePanelTitle",
  pinned: "chat.pinnedList",
};

const PANEL_BODIES: Record<DockPanelId, ComponentType> = {
  members: MemberPanel,
  soundboard: SoundboardPanel,
  memeboard: MemeboardPanel,
  transcript: TranscriptPanel,
  voice: VoiceStatusPanel,
  pinned: PinnedPanel,
};

/** Panneau visible pour le contexte courant ? (mêmes règles que la dock) */
function useDockAvailability(): Record<DockPanelId, boolean> {
  const activeChannel = useAppStore((s) => s.activeChannel);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const hasSoundboard = useMatrixStore((s) => s.channels.some((c) => c.isSoundboard));
  const isDM = useMatrixStore((s) => s.channels.find((c) => c.id === activeChannel)?.isDM ?? false);
  return useMemo(
    () => ({ members: !!activeChannel && !isDM, soundboard: hasSoundboard, memeboard: hasSoundboard, transcript: !!connectedVoice, voice: false, pinned: !!activeChannel }),
    [activeChannel, isDM, hasSoundboard, connectedVoice],
  );
}

function FloatingPanelCard({ panel }: { panel: DockPanelId }) {
  const { t } = useTranslation();
  const rect = useLayoutStore((s) => s.floatingPanels[panel]);
  const setFloatingRect = useLayoutStore((s) => s.setFloatingRect);
  const dockFloatingPanel = useLayoutStore((s) => s.dockFloatingPanel);
  const availability = useDockAvailability();

  if (!rect) return null;
  // Contexte sans contenu (DM sans membres, hors vocal…) : la carte reste
  // ouverte — l'intention est conservée — mais ne peint rien.
  if (!availability[panel]) return null;

  // x/y < 0 = « coller en bas à droite » : recalculé ici, à chaque rendu
  // concerné (aucun effet, aucun état intermédiaire à retenir).
  const x = rect.x >= 0 ? rect.x : Math.max(12, window.innerWidth - rect.w - 24);
  const y = rect.y >= 0 ? rect.y : Math.max(12, window.innerHeight - rect.h - 24);

  // Drag par le bandeau : écouteurs fenêtre le temps du geste, snap aux coins
  // à la dépose (mêmes seuils que la carte PIP du partage).
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = x;
    let lastY = y;
    const onMoveWin = (ev: PointerEvent) => {
      lastX = Math.min(Math.max(x + ev.clientX - startX, 4), Math.max(4, window.innerWidth - rect.w - 10));
      // On garde le bandeau visible même lâché tout en bas.
      lastY = Math.min(Math.max(y + ev.clientY - startY, 4), Math.max(4, window.innerHeight - 60));
      setFloatingRect(panel, { x: lastX, y: lastY });
    };
    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      const SNAP = 48;
      const MARGIN = 12;
      let sx = lastX;
      let sy = lastY;
      if (lastX <= SNAP) sx = MARGIN;
      else if (window.innerWidth - (lastX + rect.w) <= SNAP) sx = window.innerWidth - rect.w - MARGIN;
      if (lastY <= SNAP) sy = MARGIN;
      else if (window.innerHeight - (lastY + rect.h) <= SNAP) sy = window.innerHeight - rect.h - MARGIN;
      if (sx !== lastX || sy !== lastY) setFloatingRect(panel, { x: sx, y: sy });
    };
    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
  };

  const PanelBody = PANEL_BODIES[panel];

  return (
    <div
      style={{
        position: 'fixed', left: x, top: y, width: rect.w, height: rect.h,
        zIndex: 300, display: 'flex', flexDirection: 'column',
        background: 'var(--color-surface-container-low)',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      }}
    >
      <div
        onPointerDown={(e) => { if (e.button === 0) startDrag(e); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '6px 8px', cursor: 'grab', touchAction: 'none',
          background: 'var(--color-surface-container)',
          borderBottom: '1px solid var(--color-outline-variant)',
        }}
      >
        <span aria-hidden style={{ fontSize: 11, opacity: 0.7, color: 'var(--color-on-surface-variant)' }}>⠿</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t(PANEL_TITLE_KEYS[panel])}
        </span>
        <button
          type="button"
          onClick={() => dockFloatingPanel(panel)}
          title={t("layout.dockPanelBack", { defaultValue: "Rattacher à la dock" })}
          aria-label={t("layout.dockPanelBack", { defaultValue: "Rattacher à la dock" })}
          style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3v4a2 2 0 0 1-2 2H3" />
            <path d="M15 3v4a2 2 0 0 0 2 2h4" />
            <path d="M9 21v-4a2 2 0 0 0-2-2H3" />
            <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => useLayoutStore.getState().closeDockPanel(panel)}
          title={t("layout.closePanel", { defaultValue: "Fermer le panneau" })}
          aria-label={t("layout.closePanel", { defaultValue: "Fermer le panneau" })}
          style={{ border: 'none', background: 'transparent', color: 'var(--color-on-surface-variant)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' }}
        >×</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Suspense fallback={null}>
          <PanelBody />
        </Suspense>
      </div>
      <ResizeHandle
        side="right"
        value={rect.w}
        min={FLOATING_PANEL_MIN_W}
        max={Math.max(FLOATING_PANEL_MIN_W, window.innerWidth - 40)}
        onChange={(w) => setFloatingRect(panel, { w })}
        onReset={() => setFloatingRect(panel, { w: 360 })}
        label={t("layout.resizeDockZone", { defaultValue: "Redimensionner la zone — double-clic pour la taille par défaut" })}
      />
      <ResizeHandle
        side="bottom"
        value={rect.h}
        min={FLOATING_PANEL_MIN_H}
        max={Math.max(FLOATING_PANEL_MIN_H, window.innerHeight - 60)}
        onChange={(h) => setFloatingRect(panel, { h })}
        onReset={() => setFloatingRect(panel, { h: 440 })}
        label={t("layout.resizeDockZone", { defaultValue: "Redimensionner la zone — double-clic pour la taille par défaut" })}
      />
    </div>
  );
}

/** Rend toutes les cartes flottantes ouvertes (monté par `MainArea`). */
export function FloatingPanels() {
  const floating = useLayoutStore((s) => s.floatingPanels);
  const panels = Object.keys(floating) as DockPanelId[];
  if (panels.length === 0) return null;
  return (
    <>
      {panels.map((p) => <FloatingPanelCard key={p} panel={p} />)}
    </>
  );
}
