/**
 * Android foreground service integration for voice calls.
 * Uses JavascriptInterface (__SION__) injected by MainActivity.
 */

const isAndroid = /Android/i.test(navigator.userAgent);

interface SionBridge {
  startVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean): void;
  stopVoiceService(): void;
  updateVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean): void;
  isVoiceServiceRunning(): boolean;
  setSpeakerOn(on: boolean): void;
  getPendingAction(): string;
}

function getBridge(): SionBridge | null {
  return (window as unknown as Record<string, SionBridge>).__SION__ ?? null;
}

let serviceStarted = false;

export function startVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try {
      bridge.startVoiceService(channelName, isMuted, isDeafened);
      serviceStarted = true;
      // Force speaker mode after WebRTC has started
      setTimeout(() => {
        try { bridge.setSpeakerOn(true); } catch { /* ignore */ }
      }, 1000);
    } catch (e) {
      console.warn("[Sion] Voice service start error:", e);
    }
  }
}

export function stopVoiceService() {
  if (!isAndroid) return;
  serviceStarted = false;
  const bridge = getBridge();
  if (bridge) {
    try { bridge.stopVoiceService(); } catch (e) {
      console.warn("[Sion] Voice service stop error:", e);
    }
  }
}

/** Start the Android ntfy push listener service */
export function startPushListener(topicUrl: string) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { (bridge as unknown as { startPushListener: (url: string) => void }).startPushListener(topicUrl); } catch { /* ignore */ }
  }
}

/** Save room name for notification display */
export function saveRoomName(roomId: string, roomName: string) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { (bridge as unknown as { saveRoomName: (id: string, name: string) => void }).saveRoomName(roomId, roomName); } catch { /* ignore */ }
  }
}

/** Sync notification mode to Android service */
export function setNotificationMode(mode: string) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { (bridge as unknown as { setNotificationMode: (m: string) => void }).setNotificationMode(mode); } catch { /* ignore */ }
  }
}

export function updateVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid || !serviceStarted) return;
  const bridge = getBridge();
  if (bridge) {
    try { bridge.updateVoiceService(channelName, isMuted, isDeafened); } catch (e) {
      console.warn("[Sion] Voice service update error:", e);
    }
  }
}

/** Check for pending actions from notification (called when app resumes) */
export function consumePendingActions(onAction: (action: string) => void) {
  if (!isAndroid || !serviceStarted) return;
  const bridge = getBridge();
  if (!bridge) return;
  try {
    let action = bridge.getPendingAction();
    while (action) {
      onAction(action);
      action = bridge.getPendingAction();
    }
  } catch { /* ignore */ }
}
