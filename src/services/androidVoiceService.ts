/**
 * Android foreground service integration for voice calls.
 * Uses JavascriptInterface (__SION__) injected by MainActivity.
 */

const isAndroid = /Android/i.test(navigator.userAgent);

interface SionBridge {
  startVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean): void;
  stopVoiceService(): void;
  updateVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean): void;
}

function getBridge(): SionBridge | null {
  return (window as unknown as Record<string, SionBridge>).__SION__ ?? null;
}

export function startVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { bridge.startVoiceService(channelName, isMuted, isDeafened); } catch (e) {
      console.warn("[Sion] Voice service start error:", e);
    }
  }
}

export function stopVoiceService() {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { bridge.stopVoiceService(); } catch (e) {
      console.warn("[Sion] Voice service stop error:", e);
    }
  }
}

export function updateVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { bridge.updateVoiceService(channelName, isMuted, isDeafened); } catch (e) {
      console.warn("[Sion] Voice service update error:", e);
    }
  }
}
