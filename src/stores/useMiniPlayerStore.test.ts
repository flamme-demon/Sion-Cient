import { describe, it, expect } from "vitest";
import { useMiniPlayerStore, MINI_PLAYER_MIN_W, MINI_PLAYER_MIN_H } from "./useMiniPlayerStore";

describe("useMiniPlayerStore — mini-lecteur (§2.4)", () => {
  it("ouvre à la position transmise, suit la lecture, ferme proprement", () => {
    const s = () => useMiniPlayerStore.getState();

    s().open({ src: "blob:sion-video", title: "vidéo.webm", time: 42, playing: true });
    expect(s().src).toBe("blob:sion-video");
    expect(s().title).toBe("vidéo.webm");
    expect(s().time).toBe(42);

    // La carte met à jour la position/lecture en continu (onTimeUpdate…).
    s().setTime(51);
    expect(s().time).toBe(51);
    s().setPlaying(false);
    expect(s().playing).toBe(false);

    s().close();
    expect(s().src).toBeNull();
    expect(s().time).toBe(0);
    expect(s().playing).toBe(false);
  });

  it("borne la taille de la carte, garde la position", () => {
    const s = () => useMiniPlayerStore.getState();

    s().setRect({ w: 10, h: 10 });
    expect(s().w).toBe(MINI_PLAYER_MIN_W);
    expect(s().h).toBe(MINI_PLAYER_MIN_H);

    s().setRect({ x: 120, y: 80, w: 500 });
    expect(s()).toMatchObject({ x: 120, y: 80, w: 500 });
    // Un merge partiel ne touche pas au reste.
    s().setRect({ h: 300 });
    expect(s()).toMatchObject({ x: 120, y: 80, w: 500, h: 300 });
  });
});
