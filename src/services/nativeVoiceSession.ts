import * as native from "./voiceNativeService";
import { useLiveKitStore } from "../stores/useLiveKitStore";
import type { ParticipantInfo } from "../types/livekit";
import type { AudioQualityPreset } from "../stores/useSettingsStore";

interface SessionOptions {
  url: string;
  token: string;
  room: string;
  displayName: string;
  encrypted: boolean;
  devices: { inputDevice: string; outputDevice: string };
  processing: native.NativeAudioProcessing;
  audioQuality: AudioQualityPreset;
  onParticipants: (participants: ParticipantInfo[], isCurrent: () => boolean) => void;
  onData: (data: native.VoiceNativeData, isCurrent: () => boolean) => void;
  onE2ee: (state: native.VoiceNativeE2eeState) => void;
  onLocalScreenShareFailed: (reason: string) => void | Promise<void>;
  onClosed: () => void | Promise<void>;
  onDisconnected: () => Promise<void>;
}

interface Session {
  closed: boolean;
  attempted: boolean;
  unlisten: Array<() => void>;
  setup: Promise<native.VoiceNativeStatus>;
  closing?: Promise<void>;
  options: SessionOptions;
}

// One owner for the application, even when several components use useLiveKit.
let current: Session | null = null;

export async function waitForNativeSessionCleanup(): Promise<void> {
  await current?.closing;
}

export async function disconnectNativeSession(unexpected = false): Promise<void> {
  const session = current;
  if (!session) return;
  if (session.closing) return session.closing;
  session.closed = true;
  for (const unlisten of session.unlisten.splice(0)) unlisten();
  useLiveKitStore.getState().disconnect();
  session.closing = (async () => {
    // Stop timers and overlays immediately, including while connect is pending.
    try {
      await session.options.onClosed();
    } catch (err) {
      console.warn("[Sion][voix-native] fermeture de l'interface:", err);
    }
    // A leave during connect must also close the room that connect eventually opens.
    await session.setup.catch(() => {});
    try {
      if (session.attempted) await native.voiceNativeDisconnect();
    } finally {
      try {
        if (unexpected) await session.options.onDisconnected();
      } finally {
        if (current === session) current = null;
      }
    }
  })();
  return session.closing;
}

export async function connectNativeSession(options: SessionOptions): Promise<native.VoiceNativeStatus> {
  await disconnectNativeSession();
  const session: Session = {
    closed: false, attempted: false, unlisten: [], options,
    setup: Promise.resolve(null as unknown as native.VoiceNativeStatus),
  };
  current = session;
  const isCurrent = () => current === session && !session.closed;
  let ready = false;
  let terminal = false;
  let latestStatus: native.VoiceNativeStatus | null = null;
  const register = async (subscription: Promise<() => void>) => {
    const unlisten = await subscription;
    if (!isCurrent()) {
      unlisten();
      throw new Error("Connexion vocale annulée");
    }
    session.unlisten.push(unlisten);
  };
  session.setup = (async () => {
    // All listeners are installed before Rust publishes the initial state.
    await register(native.onVoiceNativeStatus((status) => {
      if (!isCurrent() || (status.room_name && status.room_name !== options.room)) return;
      latestStatus = status;
      if (status.state === "disconnected") {
        terminal = true;
        if (ready) void disconnectNativeSession(true).catch((err) => {
          console.error("[Sion][voix-native] nettoyage après déconnexion:", err);
        });
      } else if (ready && status.state !== "connecting") {
        useLiveKitStore.getState().setConnectionState(status.state);
      }
    }));
    await register(native.onVoiceNativeParticipants((participants) => {
      if (isCurrent()) options.onParticipants(participants, isCurrent);
    }));
    await register(native.onVoiceNativeData((data) => {
      if (isCurrent()) options.onData(data, isCurrent);
    }));
    await register(native.onVoiceNativeE2eeState((state) => {
      if (isCurrent()) options.onE2ee(state);
    }));
    await register(native.onVoiceNativeLocalShareFailed((event) => {
      if (isCurrent()) void options.onLocalScreenShareFailed(event.reason);
    }));
    session.attempted = true;
    const status = await native.voiceNativeConnect(
      options.url, options.token, options.room, options.displayName, options.encrypted,
      options.devices, options.processing, options.audioQuality,
    );
    if (!isCurrent() || terminal || status.state === "disconnected") {
      throw new Error("Connexion vocale interrompue");
    }
    useLiveKitStore.getState().connect(options.room);
    const state = (latestStatus as native.VoiceNativeStatus | null)?.state ?? status.state;
    if (state === "reconnecting") useLiveKitStore.getState().setConnectionState(state);
    ready = true;
    return status;
  })();
  try {
    return await session.setup;
  } catch (err) {
    if (current === session) {
      await disconnectNativeSession().catch((cleanupError) => {
        console.error("[Sion][voix-native] nettoyage après échec:", cleanupError);
      });
    }
    throw err;
  }
}
