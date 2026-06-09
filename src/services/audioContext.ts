// A single shared Web Audio context for the app's non-realtime audio (soundboard
// playback, voice-channel cues). Browsers/CEF cap concurrent AudioContexts
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
