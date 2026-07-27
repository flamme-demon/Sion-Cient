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

/**
 * Le backend audio de CEF est-il mort ?
 *
 * PulseAudio annonce des entrées mais CEF n'en voit aucune : sa connexion au
 * serveur audio est perdue, typiquement après un rechargement du service
 * PipeWire. Chromium ne la rétablit jamais et n'expose aucun moyen de la
 * relancer — seul un redémarrage du processus répare.
 */
async function cefAudioIsDead(pulseInputs: number): Promise<boolean> {
  if (pulseInputs <= 0) return false;
  try {
    const devices = await originalEnumerate();
    return devices.filter((d) => d.kind === "audioinput").length === 0;
  } catch {
    return true;
  }
}

/** Capturée avant que le shim ne surcharge l'API, pour pouvoir interroger CEF
 *  lui-même plutôt que la liste PulseAudio que le shim substitue. */
const originalEnumerate = navigator.mediaDevices?.enumerateDevices
  ? navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  : async () => [] as MediaDeviceInfo[];

async function onDevicesChanged(pulseInputs = -1) {
  const { getCurrentRoom, refreshMicrophoneForDenoise, getDegradedMicDeviceId } =
    await import("./livekitService");

  let inputs = -1;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((d) => d.kind === "audioinput").length;
  } catch {
    /* l'énumération peut échouer sous CEF ; le compte reste indicatif */
  }

  if (await cefAudioIsDead(pulseInputs)) {
    console.error(
      `[Sion][Devices] backend audio CEF perdu : ${pulseInputs} entrée(s) côté système, ` +
      `aucune côté CEF. Un redémarrage de Sion est nécessaire.`,
    );
    const { useAppStore } = await import("../stores/useAppStore");
    useAppStore.getState().setAudioBackendLost(true);
    return;
  }

  const room = getCurrentRoom();
  if (!room) {
    console.log(`[Sion][Devices] changement détecté (${inputs} entrée(s)) — hors vocal, rien à faire`);
    return;
  }

  // Le périphérique choisi est-il revenu ? On tourne alors sur le défaut
  // système alors que l'utilisateur en avait désigné un autre : il faut le
  // rétablir, sinon son réglage resterait lettre morte jusqu'au redémarrage.
  const degradedFrom = getDegradedMicDeviceId();
  if (degradedFrom) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.some((d) => d.kind === "audioinput" && d.deviceId === degradedFrom)) {
        console.log(`[Sion][Devices] « ${degradedFrom} » est de retour — rétablissement`);
        await refreshMicrophoneForDenoise(true);
        console.log("[Sion][Devices] périphérique choisi rétabli");
        return;
      }
    } catch { /* énumération indisponible : on retombe sur la logique ci-dessous */ }
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

/** Cadence de contrôle de la piste micro. Assez court pour qu'une coupure ne
 *  dure pas, assez long pour rester gratuit. */
const HEALTH_MS = 5000;

/**
 * Vérifie que la capture est toujours vivante.
 *
 * Surveiller la LISTE des périphériques ne suffit pas : un redémarrage de
 * PulseAudio réexpose les mêmes identifiants, donc la signature ne bouge pas,
 * alors que les flux sous-jacents sont morts. Le seul témoin fiable est l'état
 * de la piste elle-même, que le navigateur passe à « ended » quand son
 * périphérique disparaît sous elle.
 */
async function checkMicHealth() {
  const { getCurrentRoom, refreshMicrophoneForDenoise } = await import("./livekitService");
  const room = getCurrentRoom();
  if (!room || !room.localParticipant.isMicrophoneEnabled) return;

  const { Track } = await import("livekit-client");
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track?.mediaStreamTrack;
  if (track && track.readyState !== "ended") return;

  console.warn("[Sion][Devices] piste micro morte — réacquisition");
  try {
    await refreshMicrophoneForDenoise(true);
    console.log("[Sion][Devices] micro réacquis après coupure");
  } catch (err) {
    console.error("[Sion][Devices] réacquisition impossible:", err);
  }
}

export async function installAudioDeviceWatcher() {
  if (installed) return;
  installed = true;

  // Contrôle de vivacité : rattrape les coupures qu'aucune liste ne signale,
  // au premier rang desquelles le redémarrage du serveur audio.
  setInterval(() => { void checkMicHealth(); }, HEALTH_MS);

  // Chemin standard — inopérant sous CEF, conservé pour les autres cibles.
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void onDevicesChanged(); }, DEBOUNCE_MS);
  });

  // Chemin réel sous CEF : Rust sonde PulseAudio et nous prévient, parce que
  // `devicechange` n'y est jamais émis (vérifié par débranchement physique).
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<number>("audio-devices-changed", (e) => {
      if (timer) clearTimeout(timer);
      const inputs = e.payload;
      timer = setTimeout(() => { timer = null; void onDevicesChanged(inputs); }, DEBOUNCE_MS);
    });
    console.log("[Sion][Devices] surveillance active (devicechange + sondage PulseAudio)");
  } catch {
    console.log("[Sion][Devices] surveillance active (devicechange seul)");
  }
}
