/**
 * Service de sons UI — génère des tons courts via Web Audio API.
 * Pas de fichiers audio externes nécessaires.
 */

let audioCtx: AudioContext | null = null;

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

function playDualTone(freq1: number, freq2: number, duration: number, delay: number, volume = 0.12) {
  playTone(freq1, duration, volume);
  setTimeout(() => playTone(freq2, duration, volume), delay);
}

/** Son de mute micro — ton descendant bref */
export function playMute() {
  playDualTone(480, 320, 0.1, 60, 0.1);
}

/** Son de unmute micro — ton montant bref */
export function playUnmute() {
  playDualTone(320, 480, 0.1, 60, 0.1);
}

/** Son de deafen (couper le son) — ton grave descendant */
export function playDeafen() {
  playDualTone(400, 250, 0.12, 80, 0.1);
}

/** Son de undeafen (rétablir le son) — ton montant */
export function playUndeafen() {
  playDualTone(250, 400, 0.12, 80, 0.1);
}

/** Son de message reçu — "blop" court et doux */
export function playMessageReceived() {
  playTone(800, 0.08, 0.08, "sine");
  setTimeout(() => playTone(1000, 0.06, 0.06, "sine"), 50);
}

/** Son de poke — mini fanfare "tada !" style trompette (arpège do-mi-sol).
 *  Sawtooth pour un timbre cuivré sans échantillon audio. */
export function playPoke() {
  const vol = 0.08;
  playTone(523, 0.10, vol, "sawtooth");                             // C5 — ta
  setTimeout(() => playTone(659, 0.10, vol, "sawtooth"), 90);       // E5 — da
  setTimeout(() => playTone(784, 0.22, vol, "sawtooth"), 180);      // G5 — daaa
}

/** Son de connexion vocale — accord montant */
export function playVoiceJoin() {
  playTone(440, 0.12, 0.1);
  setTimeout(() => playTone(554, 0.12, 0.1), 80);
  setTimeout(() => playTone(659, 0.15, 0.1), 160);
}

/** Son de déconnexion vocale — accord descendant */
export function playVoiceLeave() {
  playTone(659, 0.12, 0.1);
  setTimeout(() => playTone(554, 0.12, 0.1), 80);
  setTimeout(() => playTone(440, 0.15, 0.1), 160);
}
