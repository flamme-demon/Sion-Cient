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

export function Sidebar() {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const sidebarMode = useLayoutStore((s) => s.sidebarMode);
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

  const compact = sidebarMode === "rail";
  const width = compact ? SIDEBAR_RAIL_WIDTH : sidebarWidth;

  return (
    <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
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
      <ResizeHandle
        side="right"
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
    </div>
  );
}
