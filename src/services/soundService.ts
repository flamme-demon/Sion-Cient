/**
 * Service de sons UI — génère des tons courts via Web Audio API.
 * Pas de fichiers audio externes nécessaires.
 */

import { useAppStore } from "../stores/useAppStore";

let audioCtx: AudioContext | null = null;

// Notification tones (incoming messages, pokes, remote join/leave) are
// suppressed when the user is deafened. Action-feedback tones
// (mute/unmute/deafen/undeafen toggles) always play — they confirm the user's
// own action.
function isDeafened(): boolean {
  return useAppStore.getState().isDeafened;
}

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(frequency: number, duration: number, volume = 0.15, type: OscillatorType = "sine") {
  try {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = volume;

    // Fade out to avoid click
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Audio not available (e.g. no user interaction yet)
  }
}

// Mic mute/unmute + deafen/undeafen feedback now lives in the customizable cue
// system (voiceChannelSounds.ts: playMuteCue/playUnmuteCue/playDeafenCue/
// playUndeafenCue) so users can swap the beeps for their own MP3s.

/** Son de message reçu — "blop" court et doux */
export function playMessageReceived() {
  if (isDeafened()) return;
  playTone(800, 0.08, 0.08, "sine");
  setTimeout(() => playTone(1000, 0.06, 0.06, "sine"), 50);
}

/** Son de connexion vocale — accord montant */
export function playVoiceJoin() {
  if (isDeafened()) return;
  playTone(440, 0.12, 0.1);
  setTimeout(() => playTone(554, 0.12, 0.1), 80);
  setTimeout(() => playTone(659, 0.15, 0.1), 160);
}

/** Son de déconnexion vocale — accord descendant */
export function playVoiceLeave() {
  if (isDeafened()) return;
  playTone(659, 0.12, 0.1);
  setTimeout(() => playTone(554, 0.12, 0.1), 80);
  setTimeout(() => playTone(440, 0.15, 0.1), 160);
}
