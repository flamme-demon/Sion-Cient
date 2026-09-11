import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ServerHeader } from "../sidebar/ServerHeader";
import { ChannelList } from "../sidebar/ChannelList";
import { UserControls } from "../sidebar/UserControls";
import { AccountPopover } from "../sidebar/AccountPopover";
import { VerificationBanner } from "../sidebar/VerificationBanner";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useAppStore } from "../../stores/useAppStore";
import { MOBILE_VOICE_BAR_HEIGHT } from "../mobile/MobileVoiceBar";
import { ResizeHandle } from "./ResizeHandle";
import {
  useLayoutStore,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_RAIL_SNAP_OUT,
} from "../../stores/useLayoutStore";

/**
 * Poignée de révélation du mode masqué : une bande de 8 px sur le bord gauche
 * (jamais cliquable par accident), qui s'élargit au survol en un petit
 * chevron — un clic ramène la sidebar en rail. Ctrl+B cycle les trois modes.
 */
function HiddenSidebarHandle({ onReveal, side }: { onReveal: () => void; side: "left" | "right" }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const label = t("layout.showSidebar", { defaultValue: "Afficher le menu (Ctrl+B)" });
  const isRight = side === "right";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', width: 8, flexShrink: 0, height: '100%' }}
    >
      <button
        onClick={onReveal}
        title={label}
        aria-label={label}
        style={{
          position: 'absolute', top: '50%', transform: 'translateY(-50%)',
          ...(isRight ? { right: 0 } : { left: 0 }),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: hover ? 20 : 6, height: 64, overflow: 'hidden',
          padding: 0, cursor: 'pointer',
          borderRadius: isRight ? '8px 0 0 8px' : '0 8px 8px 0',
          border: '1px solid var(--color-outline-variant)',
          ...(isRight ? { borderRight: 'none' } : { borderLeft: 'none' }),
          background: hover ? 'var(--color-surface-container-high)' : 'var(--color-surface-container)',
          color: 'var(--color-on-surface-variant)',
          transition: 'width 150ms',
        }}
      >
        {hover && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points={isRight ? "15 6 9 12 15 18" : "9 6 15 12 9 18"} />
          </svg>
        )}
      </button>
    </div>
  );
}

export function Sidebar() {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const sidebarMode = useLayoutStore((s) => s.sidebarMode);
  const sidebarSide = useLayoutStore((s) => s.sidebarSide);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const resetSidebar = useLayoutStore((s) => s.resetSidebar);

  // Mobile : comportement d'origine (pleine largeur, pas de layout desktop).
  if (isMobile) {
    return (
      <div style={{
        width: '100%',
        background: 'var(--color-surface-container-low)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        paddingBottom: connectedVoice ? MOBILE_VOICE_BAR_HEIGHT : 0,
      }}>
        <ServerHeader />
        <VerificationBanner />
        <ChannelList />
        <AccountPopover />
      </div>
    );
  }

  // Masquée : seule la poignée de révélation reste (déployer = clic ou Ctrl+B).
  if (sidebarMode === "hidden") {
    return <HiddenSidebarHandle side={sidebarSide} onReveal={() => useLayoutStore.getState().setSidebarMode("rail")} />;
  }

  const compact = sidebarMode === "rail";
  const width = compact ? SIDEBAR_RAIL_WIDTH : sidebarWidth;
  // Menu à droite : la poignée passe sur son bord GAUCHE (le bord intérieur,
  // côté contenu) et le sens de tirage s'inverse. Sinon elle reste entre le
  // menu et le chat — jamais sur le bord de la fenêtre.
  const onRight = sidebarSide === "right";

  const handle = (
    <ResizeHandle
      side={onRight ? "left" : "right"}
      value={width}
      // Depuis le rail, le drag démarre ancré juste sous le seuil de
      // déploiement : le premier pixel vers la droite redéploie la sidebar.
      startValue={compact ? SIDEBAR_RAIL_SNAP_OUT - 1 : sidebarWidth}
      min={SIDEBAR_RAIL_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      onChange={setSidebarWidth}
      onReset={resetSidebar}
      label={t("layout.resizeSidebar", {
        defaultValue: "Redimensionner le menu — double-clic pour la taille par défaut, Ctrl+B pour replier",
      })}
    />
  );

  return (
    <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
      {onRight && handle}
      <div style={{
        width,
        minWidth: width,
        maxWidth: width,
        background: 'var(--color-surface-container-low)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        // Pendant un drag vers le bas, le contenu (noms de salons) est rogné
        // plutôt que de déborder sur le chat.
        overflow: 'hidden',
      }}>
        <ServerHeader compact={compact} />
        <VerificationBanner compact={compact} />
        <ChannelList compact={compact} />
        <UserControls compact={compact} />
      </div>
      {!onRight && handle}
    </div>
  );
}
