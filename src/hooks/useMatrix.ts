import { useCallback } from "react";
import { useMatrixStore } from "../stores/useMatrixStore";
import * as matrixService from "../services/matrixService";

export function useMatrix() {
  const { channels, messages, connectionStatus, sendMessage } = useMatrixStore();

  const login = useCallback(async (homeserverUrl: string, userId: string, password: string) => {
    await matrixService.initMatrixClient({ homeserverUrl, userId, password });
    await matrixService.startSync();
  }, []);

  const logout = useCallback(() => {
    matrixService.logout();
  }, []);

  const joinRoom = useCallback(async (roomId: string) => {
    await matrixService.joinRoom(roomId);
  }, []);

  const leaveRoom = useCallback(async (roomId: string) => {
    await matrixService.leaveRoom(roomId);
  }, []);

  return {
    channels,
    messages,
    connectionStatus,
    login,
    logout,
    joinRoom,
    leaveRoom,
    sendMessage,
  };
}
