import { ServerHeader } from "../sidebar/ServerHeader";
import { ChannelList } from "../sidebar/ChannelList";
import { UserControls } from "../sidebar/UserControls";
import { AccountPopover } from "../sidebar/AccountPopover";
import { VerificationBanner } from "../sidebar/VerificationBanner";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useAppStore } from "../../stores/useAppStore";
import { MOBILE_VOICE_BAR_HEIGHT } from "../mobile/MobileVoiceBar";

export function Sidebar() {
  const isMobile = useIsMobile();
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);

  return (
    <div style={{
      width: isMobile ? '100%' : 260,
      minWidth: isMobile ? undefined : 260,
      background: 'var(--color-surface-container-low)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      paddingBottom: isMobile && connectedVoice ? MOBILE_VOICE_BAR_HEIGHT : 0,
    }}>
      <ServerHeader />
      <VerificationBanner />
      <ChannelList />
      {!isMobile && <UserControls />}
      {isMobile && <AccountPopover />}
    </div>
  );
}
