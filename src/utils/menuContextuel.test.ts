import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent, TouchEvent } from "react";
import { gestesMenuContextuel, ouvertALInstant } from "./menuContextuel";

const toucher = (x: number, y: number) =>
  ({ touches: [{ clientX: x, clientY: y }], preventDefault: vi.fn() }) as unknown as TouchEvent;
const relacher = () => ({ touches: [], preventDefault: vi.fn() }) as unknown as TouchEvent;
const clicDroit = (x: number, y: number) =>
  ({ clientX: x, clientY: y, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as MouseEvent;

describe("menu contextuel : clic droit et appui long", () => {
  let maintenant = 10_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => maintenant);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    maintenant += 5_000;
  });

  it("ouvre au clic droit, là où il a eu lieu", () => {
    const ouvrir = vi.fn();
    gestesMenuContextuel(ouvrir).onContextMenu(clicDroit(40, 50));
    expect(ouvrir).toHaveBeenCalledWith(40, 50);
  });

  it("ouvre après 500 ms d'appui sans bouger, sous le doigt", () => {
    const ouvrir = vi.fn();
    const g = gestesMenuContextuel(ouvrir);
    g.onTouchStart(toucher(100, 200));
    vi.advanceTimersByTime(499);
    expect(ouvrir).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ouvrir).toHaveBeenCalledWith(100, 200);
  });

  it("un doigt qui glisse (défilement) n'ouvre rien", () => {
    const ouvrir = vi.fn();
    const g = gestesMenuContextuel(ouvrir);
    g.onTouchStart(toucher(100, 200));
    g.onTouchMove(toucher(100, 230));
    vi.advanceTimersByTime(600);
    expect(ouvrir).not.toHaveBeenCalled();
  });

  it("un toucher bref reste un toucher", () => {
    const ouvrir = vi.fn();
    const g = gestesMenuContextuel(ouvrir);
    g.onTouchStart(toucher(100, 200));
    vi.advanceTimersByTime(200);
    const fin = relacher();
    g.onTouchEnd(fin);
    vi.advanceTimersByTime(600);
    expect(ouvrir).not.toHaveBeenCalled();
    expect(fin.preventDefault).not.toHaveBeenCalled();
  });

  it("après un appui long : ni second menu, ni toucher au relâcher, ni fermeture immédiate", () => {
    const ouvrir = vi.fn();
    const g = gestesMenuContextuel(ouvrir);
    g.onTouchStart(toucher(100, 200));
    vi.advanceTimersByTime(500);
    g.onContextMenu(clicDroit(100, 200));
    expect(ouvrir).toHaveBeenCalledTimes(1);
    const fin = relacher();
    g.onTouchEnd(fin);
    expect(fin.preventDefault).toHaveBeenCalled();
    expect(ouvertALInstant()).toBe(true);
    // Une seconde plus tard, le clic droit refonctionne normalement.
    maintenant += 1_000;
    expect(ouvertALInstant()).toBe(false);
    g.onContextMenu(clicDroit(5, 6));
    expect(ouvrir).toHaveBeenLastCalledWith(5, 6);
  });
});
