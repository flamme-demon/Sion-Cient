// A single shared Web Audio context for the app's non-realtime audio (soundboard
// playback, voice-channel cues). Les webviews plafonnent les AudioContexts concurrents
// (~6), so the soundboard and cue paths share this one instead of each holding
// their own. (The denoise worklet keeps its own 48 kHz context — it has a
// hard sample-rate requirement.)
let shared: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!shared || shared.state === "closed") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    shared = new Ctor();
  }
  return shared;
}

// WebKit exige un geste utilisateur avant de laisser un AudioContext produire
// du son (politique autoplay). Les cues de mute/sourdine sont déclenchés par
// un clic, mais la reprise du contexte est asynchrone : on débloque donc le
// contexte au tout premier geste et on joue un buffer silencieux pour forcer
// l'état `running`. Sans ça, le premier cue (ou un cue après un long silence)
// peut être avalé.
let unlocked = false;

function unlockSharedAudio() {
  if (unlocked) return;
  unlocked = true;
  try {
    const ctx = getSharedAudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    unlocked = false;
    return;
  }
  window.removeEventListener("pointerdown", unlockSharedAudio, true);
  window.removeEventListener("keydown", unlockSharedAudio, true);
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlockSharedAudio, true);
  window.addEventListener("keydown", unlockSharedAudio, true);
  // Le contexte peut être suspendu en arrière-plan : on le relance au retour.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    unlocked = false;
    window.addEventListener("pointerdown", unlockSharedAudio, true);
    window.addEventListener("keydown", unlockSharedAudio, true);
    unlockSharedAudio();
  });
}
