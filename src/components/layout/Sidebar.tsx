import { ServerHeader } from "../sidebar/ServerHeader";
import { ChannelList } from "../sidebar/ChannelList";
import { UserControls } from "../sidebar/UserControls";
import { VerificationBanner } from "../sidebar/VerificationBanner";

export function Sidebar() {
  return (
    <div style={{
      width: 260,
      minWidth: 260,
      background: 'var(--color-surface-container-low)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <ServerHeader />
      <VerificationBanner />
      <ChannelList />
      <UserControls />
    </div>
  );
}
