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
  hasMicPermission?(): boolean;
  requestMicPermission?(): void;
  micPermissionState?(): "attente" | "accordée" | "refusée";
}

function getBridge(): SionBridge | null {
  return (window as unknown as Record<string, SionBridge>).__SION__ ?? null;
}

let serviceStarted = false;

/**
 * Android : autorisation du micro, demandée au besoin avant d'entrer en
 * vocal. La voix Rust capte par le micro Java de WebRTC, qui l'exige ;
 * l'ancienne voix JS l'obtenait par le WebView. Rend `false` si refusée.
 */
export async function autoriserMicro(): Promise<boolean> {
  if (!isAndroid) return true;
  const bridge = getBridge();
  if (!bridge?.hasMicPermission || !bridge.requestMicPermission || !bridge.micPermissionState) return true;
  if (bridge.hasMicPermission()) return true;
  bridge.requestMicPermission();
  // La boîte de dialogue d'Android répond à l'activité : on attend sa réponse.
  const limite = Date.now() + 120_000;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 250));
    const etat = bridge.micPermissionState();
    if (etat !== "attente") return etat === "accordée";
  }
  return false;
}

export function startVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try {
      bridge.startVoiceService(channelName, isMuted, isDeafened);
      serviceStarted = true;
      // La sortie audio (casque, sinon haut-parleur) est choisie par le
      // service d'appel lui-même : forcer le haut-parleur ici écrasait un
      // casque Bluetooth.
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

/** Arrête l'écoute ntfy (déconnexion). */
export function stopPushListener() {
  if (!isAndroid) return;
  const bridge = getBridge();
  if (bridge) {
    try { (bridge as unknown as { stopPushListener: () => void }).stopPushListener(); } catch { /* ignore */ }
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
