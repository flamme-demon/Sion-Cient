import { useCallback, useRef } from "react";
import type { BaseKeyProvider } from "livekit-client";
import { useLiveKitStore } from "../stores/useLiveKitStore";
import * as livekitService from "../services/livekitService";

export function useLiveKit() {
  const { connected, roomName, participants } = useLiveKitStore();
  const { connect: storeConnect, disconnect: storeDisconnect, setParticipants } = useLiveKitStore();
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdate = useRef<typeof participants | null>(null);
  const cleanupParticipantChange = useRef<(() => void) | null>(null);
  const cleanupNative = useRef<(() => void) | null>(null);

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

  const connect = useCallback(async (url: string, token: string, room: string, e2eeKeyProvider?: BaseKeyProvider) => {    const lkRoom = await livekitService.connectToRoom(url, token, e2eeKeyProvider);
    storeConnect(room);

    cleanupParticipantChange.current = livekitService.onParticipantChange((updatedParticipants) => {
      pushThrottled(updatedParticipants);
    });

    return lkRoom;
  }, [storeConnect, pushThrottled]);

  /** Chemin natif (chantier no-CEF) : la Room vit en Rust, le store reçoit
   *  la même forme `ParticipantInfo` via `voice-native-participants`. */
  const connectNative = useCallback(async (url: string, token: string, room: string) => {
    const native = await import("../services/voiceNativeService");
    await native.voiceNativeConnect(url, token, room);
    storeConnect(room);
    cleanupNative.current = await native.onVoiceNativeParticipants((updatedParticipants) => {
      pushThrottled(updatedParticipants);
    });
  }, [storeConnect, pushThrottled]);

  const disconnect = useCallback(async () => {
    if (cleanupParticipantChange.current) {
      cleanupParticipantChange.current();
      cleanupParticipantChange.current = null;
    }
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }
    pendingUpdate.current = null;
    await livekitService.disconnectFromRoom();
    storeDisconnect();
  }, [storeDisconnect]);

  const disconnectNative = useCallback(async () => {
    if (cleanupNative.current) {
      cleanupNative.current();
      cleanupNative.current = null;
    }
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }
    pendingUpdate.current = null;
    const native = await import("../services/voiceNativeService");
    await native.voiceNativeDisconnect();
    storeDisconnect();
  }, [storeDisconnect]);

  const toggleMic = useCallback(async (enabled: boolean) => {
    await livekitService.toggleMicrophone(enabled);
  }, []);

  const toggleScreenShare = useCallback(async (enabled: boolean) => {
    await livekitService.toggleScreenShare(enabled);
  }, []);

  return {
    connected,
    roomName,
    participants,
    connect,
    disconnect,
    connectNative,
    disconnectNative,
    toggleMic,
    toggleScreenShare,
  };
}
