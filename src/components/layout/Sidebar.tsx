import { ServerHeader } from "../sidebar/ServerHeader";
import { ChannelList } from "../sidebar/ChannelList";
import { UserControls } from "../sidebar/UserControls";
import { VerificationBanner } from "../sidebar/VerificationBanner";
import { useIsMobile } from "../../hooks/useIsMobile";

export function Sidebar() {
  const isMobile = useIsMobile();

  return (
    <div style={{
      width: isMobile ? '100%' : 260,
      minWidth: isMobile ? undefined : 260,
      background: 'var(--color-surface-container-low)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      <ServerHeader />
      <VerificationBanner />
      <ChannelList />
      <UserControls />
    </div>
  );
}
