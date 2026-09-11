import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import {
  useLayoutStore,
  DOCK_SIDE_MIN_SIZE,
  DOCK_SIDE_MAX_SIZE,
  DOCK_SIDE_DEFAULT_SIZE,
  DOCK_BOTTOM_MIN_SIZE,
  DOCK_BOTTOM_MAX_SIZE,
  DOCK_BOTTOM_DEFAULT_SIZE,
  type DockPanelId,
  type DockZoneId,
} from "../../stores/useLayoutStore";
import { ResizeHandle } from "./ResizeHandle";
import { MemberPanel } from "../chat/MemberPanel";
import { SoundboardPanel } from "../chat/SoundboardPanel";
import { TranscriptPanel } from "../chat/TranscriptPanel";

/**
 * Une zone de la dock (roadmap §1.6) : à droite en colonne, ou en bas en
 * bandeau. Elle porte la poignée de redimensionnement, une barre d'onglets
 * (les panneaux qui y sont déplacés) et le menu du panneau actif (déplacer
 * vers l'autre zone, fermer). Les panneaux eux-mêmes ne connaissent plus ni
 * leur largeur ni leur place — ils sont du contenu pur.
 */
const PANEL_TITLE_KEYS: Record<DockPanelId, string> = {
  members: "members.title",
  soundboard: "soundboard.title",
  transcript: "transcript.title",
};

const PANEL_BODIES: Record<DockPanelId, () => ReactNode> = {
  members: MemberPanel,
  soundboard: SoundboardPanel,
  transcript: TranscriptPanel,
};

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
    () => ({ members: !!activeChannel && !isDM, soundboard: hasSoundboard, transcript: !!connectedVoice }),
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
          <button
            role="menuitem"
            onClick={() => { useLayoutStore.getState().moveDockPanel(panel, zone === "right" ? "bottom" : "right"); setOpen(false); }}
            style={itemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-container-high)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {zone === "right"
              ? t("layout.moveToBottom", { defaultValue: "Déplacer en bas" })
              : t("layout.moveToRight", { defaultValue: "Déplacer à droite" })}
          </button>
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
  const availability = useDockAvailability();

  const visible = zoneState.panels.filter((p) => availability[p]);
  const active = visible.length === 0
    ? null
    : (zoneState.active && visible.includes(zoneState.active) ? zoneState.active : visible[0]);
  if (!active) return null;

  const PanelBody = PANEL_BODIES[active];
  const isRight = zone === "right";
  const min = isRight ? DOCK_SIDE_MIN_SIZE : DOCK_BOTTOM_MIN_SIZE;
  const max = isRight ? DOCK_SIDE_MAX_SIZE : DOCK_BOTTOM_MAX_SIZE;
  const defaultSize = isRight ? DOCK_SIDE_DEFAULT_SIZE : DOCK_BOTTOM_DEFAULT_SIZE;

  const bar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, padding: '3px 4px', flexShrink: 0,
      background: 'var(--color-surface-container)',
      borderBottom: '1px solid var(--color-outline-variant)',
    }}>
      {visible.map((p) => {
        const isActive = p === active;
        return (
          <button
            key={p}
            onClick={() => setDockZoneActive(zone, p)}
            style={{
              padding: '4px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12, fontWeight: isActive ? 600 : 500,
              background: isActive ? 'var(--color-secondary-container)' : 'transparent',
              color: isActive ? 'var(--color-on-secondary-container)' : 'var(--color-on-surface-variant)',
            }}
          >{t(PANEL_TITLE_KEYS[p])}</button>
        );
      })}
      <div style={{ flex: 1 }} />
      <ZoneMenu panel={active} zone={zone} />
    </div>
  );

  const handle = (
    <ResizeHandle
      side={isRight ? "left" : "top"}
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
  };

  if (isRight) {
    return (
      <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
        {handle}
        <aside style={{ ...shellStyle, width: zoneState.size, borderLeft: '1px solid var(--color-outline-variant)' }}>
          {bar}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <PanelBody />
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {handle}
      <section style={{ ...shellStyle, height: zoneState.size, borderTop: '1px solid var(--color-outline-variant)' }}>
        {bar}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <PanelBody />
        </div>
      </section>
    </div>
  );
}
