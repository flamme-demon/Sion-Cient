/**
 * Android foreground service integration for voice calls.
 * Calls Rust commands that invoke the Kotlin VoiceCallService via JNI.
 */
import { invoke } from "@tauri-apps/api/core";

const isAndroid = /Android/i.test(navigator.userAgent);

export function startVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid) return;
  invoke("start_voice_service", { channelName, isMuted, isDeafened }).catch((err) =>
    console.warn("[Sion] Failed to start voice service:", err)
  );
}

export function stopVoiceService() {
  if (!isAndroid) return;
  invoke("stop_voice_service").catch((err) =>
    console.warn("[Sion] Failed to stop voice service:", err)
  );
}

export function updateVoiceService(channelName: string, isMuted: boolean, isDeafened: boolean) {
  if (!isAndroid) return;
  startVoiceService(channelName, isMuted, isDeafened);
}
