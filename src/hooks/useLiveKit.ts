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

  const connect = useCallback(async (url: string, token: string, room: string, e2eeKeyProvider?: BaseKeyProvider) => {
    const lkRoom = await livekitService.connectToRoom(url, token, e2eeKeyProvider);
    storeConnect(room);

    cleanupParticipantChange.current = livekitService.onParticipantChange((updatedParticipants) => {
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
    });

    return lkRoom;
  }, [storeConnect, setParticipants]);

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
    toggleMic,
    toggleScreenShare,
  };
}
