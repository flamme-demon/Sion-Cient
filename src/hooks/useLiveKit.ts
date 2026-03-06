import { useCallback } from "react";
import type { BaseKeyProvider } from "livekit-client";
import { useLiveKitStore } from "../stores/useLiveKitStore";
import * as livekitService from "../services/livekitService";

export function useLiveKit() {
  const { connected, roomName, participants } = useLiveKitStore();
  const { connect: storeConnect, disconnect: storeDisconnect, setParticipants } = useLiveKitStore();

  const connect = useCallback(async (url: string, token: string, room: string, e2eeKeyProvider?: BaseKeyProvider) => {
    const lkRoom = await livekitService.connectToRoom(url, token, e2eeKeyProvider);
    storeConnect(room);

    livekitService.onParticipantChange((updatedParticipants) => {
      setParticipants(updatedParticipants);
    });

    return lkRoom;
  }, [storeConnect, setParticipants]);

  const disconnect = useCallback(async () => {
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
