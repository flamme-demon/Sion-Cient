import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { MemberPanel } from "../chat/MemberPanel";
import { SoundboardPanel } from "../chat/SoundboardPanel";
import { TranscriptPanel } from "../chat/TranscriptPanel";
import { VoiceStatusPanel } from "../chat/VoiceStatusPanel";

/**
 * Une zone de la dock (roadmap §1.6) : à droite en colonne, ou en bas en
 * bandeau. Elle porte la poignée de redimensionnement, une barre d'onglets
 * (les panneaux qui y sont déplacés) et le menu du panneau actif (déplacer
 * vers l'autre zone, fermer). Les panneaux eux-mêmes ne connaissent plus ni
 * leur largeur ni leur place — ils sont du contenu pur.
 *
 * Les onglets se glissent à la souris (pointer events, jamais HTML5 DnD —
 * WebKitGTK) vers l'autre zone ; pendant le drag, la zone survolée se
 * surligne et une bande « Déposer ici » apparaît si elle est vide (sinon elle
 * ne serait pas rendue, donc pas une cible).
 */
const PANEL_TITLE_KEYS: Record<DockPanelId, string> = {
  members: "members.title",
  soundboard: "soundboard.title",
  transcript: "transcript.title",
  voice: "layout.voicePanelTitle",
};

const PANEL_BODIES: Record<DockPanelId, () => ReactNode> = {
  members: MemberPanel,
  soundboard: SoundboardPanel,
  transcript: TranscriptPanel,
  voice: VoiceStatusPanel,
};

/** Zone sous un point de l'écran (les conteneurs portent `data-dock-zone`). */
function zoneAtPoint(x: number, y: number): DockZoneId | null {
  const el = document.elementFromPoint(x, y);
  const holder = el?.closest?.("[data-dock-zone]") as HTMLElement | null;
  const value = holder?.dataset.dockZone;
  return value === "right" || value === "bottom" ? value : null;
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
    () => ({ members: !!activeChannel && !isDM, soundboard: hasSoundboard, transcript: !!connectedVoice, voice: !!connectedVoice }),
    [activeChannel, isDM, hasSoundboard, connectedVoice],
  );
}

/** Menu du panneau actif : le déplacer vers l'autre zone, ou le fermer. */
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
        title={t("layout.panelMenu", { defaultValue: "Panneau : déplacer ou fermer" })}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          border: 'none', background: open ? 'var(--color-surface-container-high)' : 'transparent',
          color: 'var(--color-on-surface-variant)', cursor: 'pointer',
          fontSize: 14, lineHeight: 1, padding: '4px 8px', borderRadius: 8,
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
            {t("layout.closePanel", { defaultValue: "Fermer le panneau" })}
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
  const setDockZoneActive = useLayoutStore((s) => s.setDockZoneActive);
  const setPanelDrag = useLayoutStore((s) => s.setPanelDrag);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragOverZone = useLayoutStore((s) => s.dragOverZone);
  const availability = useDockAvailability();
  const dragPointer = useRef<number | null>(null);

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

  // Zone vide : elle n'est pas rendue… sauf pendant un drag, où elle devient
  // une bande de dépôt (sinon impossible d'y glisser un panneau).
  if (visible.length === 0) {
    if (!draggingPanel) return null;
    return isRight ? (
      <div
        data-dock-zone="right"
        style={{
          width: dropActive ? 150 : 84, flexShrink: 0, margin: 6, borderRadius: 12,
          border: '2px dashed var(--color-outline-variant)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--color-on-surface-variant)', fontSize: 11, textAlign: 'center',
          padding: 8, transition: 'width 120ms', lineHeight: 1.4,
        }}
      >{t("layout.dropHere", { defaultValue: "Déposer ici" })}</div>
    ) : (
      <div
        data-dock-zone={zone}
        style={{
          height: dropActive ? 104 : 64, flexShrink: 0, margin: 6, borderRadius: 12,
          border: '2px dashed var(--color-outline-variant)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--color-on-surface-variant)', fontSize: 11,
          transition: 'height 120ms',
        }}
      >{t("layout.dropHere", { defaultValue: "Déposer ici" })}</div>
    );
  }

  const active = zoneState.active && visible.includes(zoneState.active) ? zoneState.active : visible[0];
  const PanelBody = PANEL_BODIES[active];
  const min = isRight ? DOCK_SIDE_MIN_SIZE : isTop ? DOCK_TOP_MIN_SIZE : DOCK_BOTTOM_MIN_SIZE;
  const max = isRight ? DOCK_SIDE_MAX_SIZE : isTop ? DOCK_TOP_MAX_SIZE : DOCK_BOTTOM_MAX_SIZE;
  const defaultSize = isRight ? DOCK_SIDE_DEFAULT_SIZE : isTop ? DOCK_TOP_DEFAULT_SIZE : DOCK_BOTTOM_DEFAULT_SIZE;

  const bar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, padding: '3px 4px', flexShrink: 0,
      background: 'var(--color-surface-container)',
      borderBottom: '1px solid var(--color-outline-variant)',
    }}>
      {visible.map((p) => {
        const isActive = p === active;
        const isDragged = draggingPanel === p;
        return (
          <button
            key={p}
            onClick={() => setDockZoneActive(zone, p)}
            title={t("layout.dragPanel", { defaultValue: "Glisser pour déplacer le panneau vers l'autre zone" })}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              dragPointer.current = e.pointerId;
              setPanelDrag(p);
            }}
            onPointerMove={(e) => {
              if (dragPointer.current !== e.pointerId) return;
              const over = zoneAtPoint(e.clientX, e.clientY);
              if (over !== dragOverZone) setPanelDrag(p, over);
            }}
            onPointerUp={(e) => {
              if (dragPointer.current !== e.pointerId) return;
              dragPointer.current = null;
              const target = zoneAtPoint(e.clientX, e.clientY);
              if (target && target !== zone) useLayoutStore.getState().moveDockPanel(p, target);
              setPanelDrag(null);
            }}
            onPointerCancel={() => { dragPointer.current = null; setPanelDrag(null); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 8, border: 'none',
              cursor: isDragged ? 'grabbing' : 'grab',
              fontFamily: 'inherit', fontSize: 12, fontWeight: isActive ? 600 : 500,
              background: isActive ? 'var(--color-secondary-container)' : 'transparent',
              color: isActive ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
              opacity: isDragged ? 0.6 : 1,
              touchAction: 'none',
            }}
          >
            <span aria-hidden style={{ fontSize: 10, opacity: 0.7, lineHeight: 1 }}>⠿</span>
            {t(PANEL_TITLE_KEYS[p])}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      <ZoneMenu panel={active} zone={zone} />
    </div>
  );

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

  const body = (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <DockZoneContext.Provider value={zone}><PanelBody /></DockZoneContext.Provider>
    </div>
  );

  if (isRight) {
    return (
      <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
        {handle}
        <aside data-dock-zone="right" style={{ ...shellStyle, width: zoneState.size, borderLeft: '1px solid var(--color-outline-variant)' }}>
          {bar}
          {body}
        </aside>
      </div>
    );
  }

  // Bandeau haut : contenu puis poignée (le bord intérieur est en bas).
  if (isTop) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <section data-dock-zone="top" style={{ ...shellStyle, height: zoneState.size, borderBottom: '1px solid var(--color-outline-variant)' }}>
          {bar}
          {body}
        </section>
        {handle}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {handle}
      <section data-dock-zone="bottom" style={{ ...shellStyle, height: zoneState.size, borderTop: '1px solid var(--color-outline-variant)' }}>
        {bar}
        {body}
      </section>
    </div>
  );
}
