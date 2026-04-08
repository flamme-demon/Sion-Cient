import { create } from "zustand";
import type { ParticipantInfo } from "../types/livekit";

export type LiveKitConnectionState = "connected" | "reconnecting" | "disconnected";

interface LiveKitState {
  connected: boolean;
  roomName: string | null;
  participants: ParticipantInfo[];
  connectionState: LiveKitConnectionState;

  connect: (roomName: string) => void;
  disconnect: () => void;
  setParticipants: (participants: ParticipantInfo[]) => void;
  setConnectionState: (state: LiveKitConnectionState) => void;
}

export const useLiveKitStore = create<LiveKitState>((set) => ({
  connected: false,
  roomName: null,
  participants: [],
  connectionState: "disconnected",

  connect: (roomName) => set({ connected: true, roomName, connectionState: "connected" }),
  disconnect: () => set({ connected: false, roomName: null, participants: [], connectionState: "disconnected" }),
  setParticipants: (participants) => set({ participants }),
  setConnectionState: (state) => set({ connectionState: state }),
}));
