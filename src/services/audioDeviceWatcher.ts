// Surveillance du branchement à chaud des périphériques audio.
//
// Brancher un casque en cours de session laissait Sion sans micro : rien ne
// réacquérait la capture. `devicechange` n'était écouté que par le panneau de
// réglages, et seulement pour rafraîchir la liste affichée — donc uniquement
// quand ce panneau était ouvert.
//
// On réacquiert désormais le micro dès que la topologie change, à condition
// d'être en vocal. Les traces relèvent ce que voit CEF à chaque événement :
// c'est le seul moyen de distinguer une liste réellement mise à jour d'un
// backend audio resté figé depuis le démarrage du processus.

/** Les événements arrivent en rafale (un par nœud PipeWire touché). */
const DEBOUNCE_MS = 800;

let installed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function onDevicesChanged() {
  const { getCurrentRoom, refreshMicrophoneForDenoise } = await import("./livekitService");

  let inputs = -1;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((d) => d.kind === "audioinput").length;
  } catch {
    /* l'énumération peut échouer sous CEF ; le compte reste indicatif */
  }

  const room = getCurrentRoom();
  if (!room) {
    console.log(`[Sion][Devices] changement détecté (${inputs} entrée(s)) — hors vocal, rien à faire`);
    return;
  }

  // Une piste peut survivre à la disparition de son périphérique en restant
  // muette : on la considère morte dès qu'elle est terminée.
  const { Track } = await import("livekit-client");
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track?.mediaStreamTrack;
  const dead = !track || track.readyState === "ended";

  console.log(
    `[Sion][Devices] changement détecté : ${inputs} entrée(s) audio, ` +
    `piste micro ${dead ? "morte/absente" : "vivante"}`,
  );
  if (!dead) return;

  try {
    // `force` : la publication peut être absente, auquel cas le micro compte
    // comme désactivé et le rafraîchissement s'abstiendrait.
    await refreshMicrophoneForDenoise(true);
    console.log("[Sion][Devices] micro réacquis");
  } catch (err) {
    console.warn("[Sion][Devices] réacquisition du micro impossible:", err);
  }
}

export function installAudioDeviceWatcher() {
  if (installed || !navigator.mediaDevices?.addEventListener) return;
  installed = true;
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void onDevicesChanged(); }, DEBOUNCE_MS);
  });
  console.log("[Sion][Devices] surveillance du branchement à chaud active");
}
