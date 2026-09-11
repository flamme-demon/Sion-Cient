import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  getVoiceNativeAudioLevel,
  startVoiceNativeMicrophoneTest,
  stopVoiceNativeAudioTest,
} from "../services/voiceNativeService";

const ALERT_COOLDOWN_MS = 3000;

// Short "bip bip" alert sound via Web Audio API
function playMutedAlert() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.value = 0.15;

    // Two short beeps
    for (const offset of [0, 0.15]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 800;
      osc.connect(gain);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.08);
    }

    // Cleanup after sounds finish
    setTimeout(() => ctx.close(), 500);
  } catch {
    // Silently fail if audio not available
  }
}

export function useMutedSpeakDetection(onSpeakWhileMuted: () => void) {
  const isMuted = useAppStore((s) => s.isMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const connectedVoice = useAppStore((s) => s.connectedVoiceChannel);
  const mutedSpeakAlert = useSettingsStore((s) => s.mutedSpeakAlert);
  const micThreshold = useSettingsStore((s) => s.micThreshold);
  const nativeAudioInputDevice = useSettingsStore((s) => s.nativeAudioInputDevice);

  const lastAlertRef = useRef(0);
  const onSpeakRef = useRef(onSpeakWhileMuted);
  onSpeakRef.current = onSpeakWhileMuted;
  // Ref mirror of the threshold so the rAF loop picks up slider changes
  // without tearing down getUserMedia/AudioContext. Dragging the slider
  // previously re-ran the whole effect (stop tracks → ctx.close() → new
  // getUserMedia), taking ~200–500 ms each tick and making the setting
  // feel "ignored until reload".
  const micThresholdRef = useRef(micThreshold);
  micThresholdRef.current = micThreshold;

  const triggerAlert = useCallback(() => {
    const now = Date.now();
    if (now - lastAlertRef.current > ALERT_COOLDOWN_MS) {
      lastAlertRef.current = now;
      playMutedAlert();
      onSpeakRef.current();
    }
  }, []);

  useEffect(() => {
    // Skip when deafened: the user is intentionally AFK (mic + speakers off),
    // they don't need an alert that they're muted because they already know.
    if (!isMuted || isDeafened || !connectedVoice || !mutedSpeakAlert) return;

    // Le moteur Rust dispose déjà du RMS issu de son APM. Maintenir l'ADM en
    // capture pendant le mute permet l'alerte sans ouvrir un getUserMedia
    // concurrente et sans republier la moindre piste LiveKit.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let previousSequence = -1;
    const sample = async () => {
      try {
        const level = await getVoiceNativeAudioLevel();
        if (!stopped && level.sequence !== previousSequence && level.rms > micThresholdRef.current) {
          triggerAlert();
        }
        previousSequence = level.sequence;
      } catch (err) {
        if (!stopped) console.error("[Sion] Native muted speak detection failed:", err);
      } finally {
        if (!stopped) timer = setTimeout(sample, 50);
      }
    };
    void startVoiceNativeMicrophoneTest(nativeAudioInputDevice, "muted-speak-alert")
      .then(sample)
      .catch((err) => {
        if (!stopped) console.error("[Sion] Native muted speak capture failed:", err);
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
      void stopVoiceNativeAudioTest("muted-speak-alert");
    };
    // `micThreshold` intentionally omitted — the ref above carries live
    // updates without re-running the whole capture.
     
  }, [isMuted, isDeafened, connectedVoice, mutedSpeakAlert, nativeAudioInputDevice, triggerAlert]);
}
