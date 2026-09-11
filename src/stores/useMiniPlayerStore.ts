import { create } from "zustand";

/**
 * Mini-lecteur flottant des vidéos du chat (roadmap §2.4) — même primitive de
 * carte que le PIP du partage, mais pour une `<video>` de message : on garde
 * la vidéo à l'écran en changeant de salon ou en scrollant.
 *
 * Rien n'est persisté : la source est un blob/objectURL qui meurt au reload.
 * Seule la géométrie est conservée en mémoire de session.
 */
export const MINI_PLAYER_MIN_W = 240;
export const MINI_PLAYER_MIN_H = 150;

interface MiniPlayerState {
  /** Source en cours (objectURL/blob ou URL résolue). `null` = fermé. */
  src: string | null;
  title: string;
  /** Position de reprise (s), figée à l'ouverture. */
  time: number;
  playing: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  open: (video: { src: string; title: string; time: number; playing: boolean }) => void;
  close: () => void;
  setRect: (rect: Partial<{ x: number; y: number; w: number; h: number }>) => void;
  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
}

export const useMiniPlayerStore = create<MiniPlayerState>((set) => ({
  src: null,
  title: "",
  time: 0,
  playing: true,
  // x/y < 0 = « coller en bas à gauche » (le PIP du partage occupe la droite).
  x: -1,
  y: -1,
  w: 420,
  h: 260,
  open: (video) => set({ src: video.src, title: video.title, time: video.time, playing: video.playing }),
  close: () => set({ src: null, title: "", time: 0, playing: false }),
  setRect: (rect) =>
    set((s) => ({
      x: rect.x ?? s.x,
      y: rect.y ?? s.y,
      w: Math.max(MINI_PLAYER_MIN_W, rect.w ?? s.w),
      h: Math.max(MINI_PLAYER_MIN_H, rect.h ?? s.h),
    })),
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
}));
