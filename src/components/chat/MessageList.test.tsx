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
