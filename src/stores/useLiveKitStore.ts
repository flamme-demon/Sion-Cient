import { create } from "zustand";
import type { ParticipantInfo } from "../types/livekit";

interface LiveKitState {
  connected: boolean;
  roomName: string | null;
  participants: ParticipantInfo[];

  connect: (roomName: string) => void;
  disconnect: () => void;
  setParticipants: (participants: ParticipantInfo[]) => void;
}

export const useLiveKitStore = create<LiveKitState>((set) => ({
  connected: false,
  roomName: null,
  participants: [],

  connect: (roomName) => set({ connected: true, roomName }),
  disconnect: () => set({ connected: false, roomName: null, participants: [] }),
  setParticipants: (participants) => set({ participants }),
}));
