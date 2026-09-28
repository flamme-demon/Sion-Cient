import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Les stores lisent localStorage dès leur import (même préparation que
// NativeAudioSettings.test.tsx).
vi.hoisted(() => {
  const valeurs = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (cle: string) => valeurs.get(cle) ?? null,
    setItem: (cle: string, valeur: string) => { valeurs.set(cle, valeur); },
    removeItem: (cle: string) => { valeurs.delete(cle); },
  } });
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (cle: string) => cle }) }));

// Le rendu des messages n'est pas l'objet du test : seule compte la logique
// de lecture de la liste.
vi.mock("./Message", () => ({ Message: () => null }));
vi.mock("./LecteursMessage", () => ({ LecteursMessage: () => null }));

import { MessageList } from "./MessageList";
import { useAppStore } from "../../stores/useAppStore";
import { useMatrixStore } from "../../stores/useMatrixStore";
import type { ChatMessage } from "../../types/matrix";

const SALON = "!chihuahuatistant:sion.test";

function message(id: string, expediteur: string, ts: number): ChatMessage {
  return { id, eventId: id, senderId: expediteur, user: expediteur, role: "user", text: id, time: "", ts } as ChatMessage;
}

function ajouter(m: ChatMessage) {
  act(() => {
    useMatrixStore.setState((s) => ({ messages: { ...s.messages, [SALON]: [...(s.messages[SALON] ?? []), m] } }));
  });
}

let conteneur: HTMLDivElement;
let racine: Root;

beforeEach(() => {
  vi.useFakeTimers();
  // Images d'animation au rythme des minuteurs simulés.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  // Quelqu'un est devant l'écran (voir « Présence » dans MessageList).
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  // jsdom n'a ni ResizeObserver ni mise en page : tout est « en bas du fil ».
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useMatrixStore.setState({
    currentUserId: "@flamme:sion.test",
    messages: { [SALON]: [message("$1", "@picsou:sion.test", 1)] },
    roomHasMore: { [SALON]: false },
    roomLoadingHistory: {},
  });
  useAppStore.setState({ activeChannel: SALON, lastReadMessageId: {} });
  conteneur = document.createElement("div");
  document.body.appendChild(conteneur);
  racine = createRoot(conteneur);
  act(() => racine.render(<MessageList />));
});

afterEach(() => {
  act(() => racine.unmount());
  conteneur.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("un message reçu en bas du fil est lu, même si le fil a bougé juste après l'ouverture du salon", () => {
  // Les fils du démarrage arrivent dans les 5 premières secondes.
  ajouter(message("$2", "@picsou:sion.test", 2));
  act(() => vi.advanceTimersByTime(6000));

  // Bien plus tard, Narkow écrit ; on regarde le salon, en bas du fil.
  ajouter(message("$3", "@narkow:sion.test", 3));
  act(() => vi.advanceTimersByTime(100));

  expect(useAppStore.getState().lastReadMessageId[SALON]).toBe("$3");
});

it("à l'ouverture, remonte l'historique jusqu'au dernier lu pour afficher le bandeau des non-lus", () => {
  const AUTRE = "!limonadistant:sion.test";
  const anciens = [message("$10", "@narkow:sion.test", 10), message("$11", "@picsou:sion.test", 11)];
  const recents = [20, 21, 22, 23].map((ts) => message(`$${ts}`, "@narkow:sion.test", ts));
  // Le dernier lu ($10) n'est pas chargé : seule une remontée le ramène.
  const charger = vi.fn(async (salon: string) => {
    useMatrixStore.setState((s) => ({
      messages: { ...s.messages, [salon]: [...anciens, ...(s.messages[salon] ?? [])] },
      roomHasMore: { ...s.roomHasMore, [salon]: false },
    }));
  });
  useMatrixStore.setState((s) => ({
    messages: { ...s.messages, [AUTRE]: recents },
    roomHasMore: { ...s.roomHasMore, [AUTRE]: true },
    loadRoomHistory: charger,
  }));
  useAppStore.setState({ lastReadMessageId: { [AUTRE]: "$10" } });

  act(() => useAppStore.setState({ activeChannel: AUTRE }));
  act(() => vi.advanceTimersByTime(200));

  expect(charger).toHaveBeenCalledWith(AUTRE);
  expect(conteneur.querySelector("[data-unread-sep]")).not.toBeNull();
});

/** Géométrie simulée du fil (jsdom n'a pas de mise en page), puis un
 *  évènement de défilement comme en produit la molette. */
function defiler(scrollTop: number, scrollHeight = 1000, clientHeight = 400) {
  const fil = conteneur.querySelector<HTMLElement>(".overflow-y-auto")!;
  Object.defineProperty(fil, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(fil, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(fil, "scrollTop", { configurable: true, get: () => scrollTop, set: () => {} });
  act(() => { fil.dispatchEvent(new Event("scroll")); });
}

it("absent, un message reçu n'est pas lu ; au retour il faut descendre pour le lire", () => {
  act(() => vi.advanceTimersByTime(6000));
  // On quitte la fenêtre de Sion (autre application).
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  act(() => { window.dispatchEvent(new Event("blur")); });

  ajouter(message("$2", "@narkow:sion.test", 2));
  act(() => vi.advanceTimersByTime(100));
  expect(useAppStore.getState().lastReadMessageId[SALON]).toBe("$1");
  expect(conteneur.querySelector("[data-unread-sep]")).not.toBeNull();
  // La vue s'est arrêtée sur le bandeau, le nouveau message plus bas.
  defiler(500);

  // Retour : le message n'est pas encore sous les yeux.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  act(() => { window.dispatchEvent(new Event("focus")); });
  act(() => vi.advanceTimersByTime(100));
  expect(useAppStore.getState().lastReadMessageId[SALON]).toBe("$1");

  // On descend : lu, et le bandeau reste.
  defiler(600);
  expect(useAppStore.getState().lastReadMessageId[SALON]).toBe("$2");
  expect(conteneur.querySelector("[data-unread-sep]")).not.toBeNull();
});

it("sans souris ni clavier depuis une minute, un message reçu n'est pas lu (fil qui tient à l'écran)", () => {
  act(() => vi.advanceTimersByTime(61_000));
  ajouter(message("$2", "@narkow:sion.test", 2));
  act(() => vi.advanceTimersByTime(100));
  expect(useAppStore.getState().lastReadMessageId[SALON]).not.toBe("$2");

  // La souris bouge : on est de retour, en bas du fil.
  act(() => { window.dispatchEvent(new Event("pointermove")); });
  act(() => vi.advanceTimersByTime(100));
  expect(useAppStore.getState().lastReadMessageId[SALON]).toBe("$2");
});
