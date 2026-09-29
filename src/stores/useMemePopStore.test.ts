import { beforeEach, expect, it } from "vitest";
import { useMemePopStore } from "./useMemePopStore";

let visibilite: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilite });

const meme = (url: string) => ({ url, volume: 0.5, emetteur: "picsou" });

beforeEach(() => {
  visibilite = "visible";
  useMemePopStore.getState().vider();
});

it("Sion au premier plan : le meme s'affiche, trois au plus à l'écran", () => {
  for (const u of ["a", "b", "c", "d"]) useMemePopStore.getState().montrer(meme(u));
  expect(useMemePopStore.getState().memes.map((m) => m.url)).toEqual(["b", "c", "d"]);
});

it("Sion en arrière-plan : le meme est ignoré, et ceux à l'écran s'en vont", () => {
  useMemePopStore.getState().montrer(meme("a"));
  visibilite = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(useMemePopStore.getState().memes).toHaveLength(0);
  useMemePopStore.getState().montrer(meme("b"));
  expect(useMemePopStore.getState().memes).toHaveLength(0);
});
