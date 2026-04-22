import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";

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

    let audioCtx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let animId: number | null = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Float32Array(analyser.fftSize);

        function check() {
          analyser.getFloatTimeDomainData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sum / dataArray.length);
          if (rms > micThresholdRef.current) {
            triggerAlert();
          }
          animId = requestAnimationFrame(check);
        }
        check();
      } catch (err) {
        console.error("[Sion] Muted speak detection failed:", err);
      }
    }

    start();

    return () => {
      if (animId !== null) cancelAnimationFrame(animId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close();
    };
    // `micThreshold` intentionally omitted — the ref above carries live
    // updates without re-running the whole capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMuted, isDeafened, connectedVoice, mutedSpeakAlert, triggerAlert]);
}
