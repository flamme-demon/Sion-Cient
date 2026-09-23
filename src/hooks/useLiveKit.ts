import { useCallback, useRef } from "react";
import { useLiveKitStore } from "../stores/useLiveKitStore";
import { connectNativeSession, disconnectNativeSession } from "../services/nativeVoiceSession";
import { useSettingsStore } from "../stores/useSettingsStore";
import { setNativeCursorDisplayName } from "../services/cursorService";
import { onParticipantJoined, onParticipantLeft, noteConnectionLost, resetVoiceCues, primeActionCues } from "../services/voiceChannelSounds";
import type { ParticipantInfo } from "../types/livekit";
import { getVoiceNativeStatus } from "../services/voiceNativeService";
import type { VoiceNativeData, VoiceNativeE2eeState } from "../services/voiceNativeService";

/** Session vocale LiveKit native (moteur Rust). La webview ne crée plus de
 *  `Room` : elle suit les événements `voice-native-*` et publie ses paquets
 *  data-channel via `voice_native_publish_data`. */
export function useLiveKit() {
  const { connected, roomName, participants } = useLiveKitStore();
  const { setParticipants, disconnect: storeDisconnect } = useLiveKitStore();
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdate = useRef<typeof participants | null>(null);
  const nativeAfkHeartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Identités déjà vues (pour re-broadcast AFK aux nouveaux arrivants). */
  const knownNativeIdentities = useRef<Set<string> | null>(null);
  /** Dernière qualité connue par identité — un départ précédé de `lost`
   *  déclenche le cue « timeout » plutôt que « leave ». */
  const lastQualities = useRef<Map<string, ParticipantInfo["connectionQuality"]>>(new Map());
  const firstSnapshot = useRef(true);

  const pushThrottled = useCallback((updatedParticipants: typeof participants) => {
    // Throttle store updates to max ~4 per second to avoid choking React renders
    pendingUpdate.current = updatedParticipants;
    if (!throttleRef.current) {
      throttleRef.current = setTimeout(() => {
        throttleRef.current = null;
        if (pendingUpdate.current) {
          setParticipants(pendingUpdate.current);
          pendingUpdate.current = null;
        }
      }, 250);
    }
  }, [setParticipants]);

  const clearNativeResources = useCallback(async () => {
    if (nativeAfkHeartbeat.current) clearInterval(nativeAfkHeartbeat.current);
    nativeAfkHeartbeat.current = null;
    if (throttleRef.current) clearTimeout(throttleRef.current);
    throttleRef.current = null;
    pendingUpdate.current = null;
    knownNativeIdentities.current = null;
    lastQualities.current = new Map();
    firstSnapshot.current = true;
    resetVoiceCues();
    setNativeCursorDisplayName(null);
    await import("../services/cursorOverlayService")
      .then(({ closeCursorOverlay }) => closeCursorOverlay())
      .catch(() => {});
  }, []);

  /** Le moteur vit en Rust : le store reçoit la même forme `ParticipantInfo`
   *  via `voice-native-participants`. */
  const connectNative = useCallback(async (url: string, token: string, room: string, displayName: string, encrypted = false, onDisconnected: () => Promise<void> = async () => {}) => {
    console.info(`[Sion][voix-native] join natif ${room} (moteur Rust)`);
    const native = await import("../services/voiceNativeService");
    await disconnectNativeSession();
    setNativeCursorDisplayName(displayName);
    knownNativeIdentities.current = new Set();
    const { useAuthStore } = await import("../stores/useAuthStore");
    const localUserId = useAuthStore.getState().credentials?.userId;
    const isLocalIdentity = (id: string) =>
      !!localUserId && (id === localUserId || id.startsWith(localUserId + ":"));
    const onParticipants = (updatedParticipants: typeof participants, isCurrent: () => boolean) => {
      // Cues TeamSpeak join/leave/timeout : le moteur Rust ne les émet pas,
      // on les dérive des différences de listes. La première liste (pairs
      // déjà présents) ne déclenche rien, et notre propre identité est ignorée.
      if (!firstSnapshot.current) {
        for (const p of updatedParticipants) {
          if (!isLocalIdentity(p.identity) && !lastQualities.current.has(p.identity)) onParticipantJoined(p.identity);
        }
        for (const [id, quality] of lastQualities.current) {
          if (updatedParticipants.some((p) => p.identity === id)) continue;
          if (quality === "lost") noteConnectionLost(id, true);
          onParticipantLeft(id);
        }
      }
      for (const p of updatedParticipants) {
        if (isLocalIdentity(p.identity)) continue;
        const was = lastQualities.current.get(p.identity);
        if (p.connectionQuality === "lost" && was !== "lost") noteConnectionLost(p.identity, true);
        else if (p.connectionQuality !== "lost" && was === "lost") noteConnectionLost(p.identity, false);
      }
      lastQualities.current = new Map(updatedParticipants.map((p) => [p.identity, p.connectionQuality]));
      firstSnapshot.current = false;
      // Rebroadcast AFK aux nouveaux arrivants : un pair qui rejoint pendant
      // notre sourdine doit l'apprendre.
      const known = knownNativeIdentities.current;
      if (known) {
        const fresh = updatedParticipants.some((p) => !known.has(p.identity));
        updatedParticipants.forEach((p) => known.add(p.identity));
        if (fresh) {
          import("../stores/useAppStore").then(({ useAppStore }) => {
            if (!isCurrent()) return;
            if (!useAppStore.getState().isDeafened) return;
            import("../services/voiceNativeService").then((svc) => {
              if (!isCurrent()) return;
              const payload = new TextEncoder().encode(JSON.stringify({ deafened: true }));
              svc.voiceNativePublishData("sion-afk", svc.bytesToB64(payload)).catch(() => {});
            }).catch(() => {});
          }).catch(() => {});
        }
        // Pairs armés pour la transcription : purge des partants + rediffusion
        // de notre intention aux nouveaux arrivants.
        import("../services/transcriptionService").then(({ syncArmedTranscribers, rebroadcastTranscribeArm }) => {
          if (!isCurrent()) return;
          syncArmedTranscribers(updatedParticipants.map((p) => p.identity));
          if (fresh) rebroadcastTranscribeArm();
        }).catch(() => {});
      }
      // État voix Matrix (`sion_muted` / `sion_deafened` des call.member) :
      // persistant et sans course, il comble les broadcasts LiveKit manqués
      // (cf. `overlayMatrixVoiceState`). Repli brut si le store est injoignable.
      import("../stores/useMatrixStore").then(({ useMatrixStore }) => {
        if (!isCurrent()) return;
        const voiceUsers =
          useMatrixStore.getState().channels.find((c) => c.id === room)?.voiceUsers ?? [];
        pushThrottled(native.overlayMatrixVoiceState(updatedParticipants, voiceUsers));
      }).catch(() => { if (isCurrent()) pushThrottled(updatedParticipants); });
    };
    // Relais data-channel natif → handlers existants (soundboard, curseurs…).
    const onData = (ev: VoiceNativeData, isCurrent: () => boolean) => {
      if (!ev.topic || !ev.sender) return;
      const sender = ev.sender;
      import("../services/soundboardService").then(({ SOUNDBOARD_TOPIC, handleRemoteBroadcast }) => {
        if (!isCurrent()) return;
        if (ev.topic !== SOUNDBOARD_TOPIC || !ev.sender) return;
        handleRemoteBroadcast(native.b64ToBytes(ev.payload_b64), ev.sender);
      }).catch(() => {});
      import("../services/memeboardService").then(({ MEMEBOARD_TOPIC, recevoirMeme }) => {
        if (!isCurrent() || ev.topic !== MEMEBOARD_TOPIC) return;
        const nom = native.resolveNativeDisplayName(sender, room);
        void recevoirMeme(native.b64ToBytes(ev.payload_b64), sender, nom)
          .catch((err) => console.warn("[Sion][meme] réception impossible", err));
      }).catch(() => {});
      import("../services/cursorService").then(({ CURSOR_TOPIC, CURSOR_CLICK_TOPIC, handleNativeCursorData }) => {
        if (!isCurrent()) return;
        if ((ev.topic !== CURSOR_TOPIC && ev.topic !== CURSOR_CLICK_TOPIC) || !sender) return;
        const name = native.resolveNativeDisplayName(sender, room);
        handleNativeCursorData(ev.topic, sender, name, native.b64ToBytes(ev.payload_b64));
      }).catch(() => {});
      import("../services/transcriptionService").then(({ TRANSCRIBE_ARM_TOPIC, handleArmData }) => {
        if (!isCurrent()) return;
        if (ev.topic !== TRANSCRIBE_ARM_TOPIC || !sender) return;
        handleArmData(sender, native.b64ToBytes(ev.payload_b64));
      }).catch(() => {});
      // Capacités média des autres clients (choix du codec de partage) —
      // matériel d'abord. Le store ignore les sujets autres que le sien.
      import("../stores/useMediaCapsStore").then(({ useMediaCapsStore }) => {
        if (!isCurrent()) return;
        useMediaCapsStore.getState().ingest(ev.topic, ev.payload_b64, sender);
      }).catch(() => {});
      // Rust route directement ces mêmes paquets vers l'overlay du sharer.
      // Ce relais JS ne conserve que l'affichage local des autres viewers via
      // `handleNativeCursorData` ci-dessus.
    };
    // Relais état E2EE natif → console (diagnostic salon chiffré : Ok /
    // MissingKey / DecryptionFailed par participant — cf. `E2eeStateChanged`).
    const onE2ee = (ev: VoiceNativeE2eeState) => {
      console.info(`[Sion][voix-native][E2EE] état ${ev.identity} : ${ev.state}`);
    };
    const onLocalScreenShareFailed = async (reason: string) => {
      console.warn(`[Sion][voix-native] partage d'écran interrompu : ${reason}`);
      const [{ useAppStore }, overlay, service] = await Promise.all([
        import("../stores/useAppStore"),
        import("../services/cursorOverlayService"),
        import("../services/voiceNativeService"),
      ]);
      useAppStore.setState({
        isScreenSharing: false,
        screenShareAudioWarning: false,
        fileError: `Partage d'écran interrompu : ${reason}`,
      });
      setTimeout(() => useAppStore.setState({ fileError: null }), 5000);
      await Promise.allSettled([
        overlay.closeCursorOverlay(),
        service.setVoiceNativeScreensharing(false),
      ]);
    };
    const settings = useSettingsStore.getState();
    await connectNativeSession({
      url, token, room, displayName, encrypted,
      devices: { inputDevice: settings.nativeAudioInputDevice, outputDevice: settings.nativeAudioOutputDevice },
      processing: { echoCancellation: settings.echoCancellation, autoGainControl: settings.autoGainControl,
        noiseSuppression: settings.aiNoiseSuppression, mix: settings.aiNoiseSuppressionMix },
      audioQuality: settings.audioQuality,
      onParticipants, onData, onE2ee, onLocalScreenShareFailed,
      onClosed: clearNativeResources, onDisconnected,
    });
    // Décodage des cues dès l'entrée en vocal : sans ça le tout premier unmute
    // attendait environ deux secondes le chargement du fichier (mesuré le
    // 16/09), alors que l'opération moteur ne prenait que 91 ms.
    void primeActionCues();
    // L'overlay curseurs ne s'OUVRE qu'à la transition « je commence à
    // partager ». Après un rechargement de webview en plein partage, le store
    // front repart à zéro alors que le moteur publie toujours : cette
    // transition n'a jamais lieu, et plus aucun curseur de viewer n'apparaît
    // sur notre écran jusqu'au relancement manuel du partage (constaté le
    // 16/09). On interroge donc la vérité terrain du moteur.
    void getVoiceNativeStatus()
      .then(async (status) => {
        if (!status.screenshare_published) return;
        const { useAppStore } = await import("../stores/useAppStore");
        useAppStore.setState({ isScreenSharing: true });
        const { openCursorOverlay } = await import("../services/cursorOverlayService");
        await openCursorOverlay();
      })
      .catch(() => {});
    // Heartbeat AFK natif : tout état manqué ou rassis chez les pairs se
    // répare sous 30 s.
    if (nativeAfkHeartbeat.current) clearInterval(nativeAfkHeartbeat.current);
    nativeAfkHeartbeat.current = setInterval(() => {
      import("../stores/useAppStore").then(({ useAppStore }) => {
        const deafened = useAppStore.getState().isDeafened;
        import("../services/voiceNativeService").then((svc) => {
          console.log(`[Sion][deafen] AFK tx natif deafened=${deafened}`);
          const payload = new TextEncoder().encode(JSON.stringify({ deafened }));
          svc.voiceNativePublishData("sion-afk", svc.bytesToB64(payload)).catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    }, 30_000);
  }, [clearNativeResources, pushThrottled]);

  const disconnectNative = useCallback(async () => {
    await disconnectNativeSession();
    storeDisconnect();
  }, [storeDisconnect]);

  return {
    connected,
    roomName,
    participants,
    connectNative,
    disconnectNative,
  };
}
