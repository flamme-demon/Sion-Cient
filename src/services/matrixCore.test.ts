import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { moteurMatrix, connecter, fils, chargerHistorique, urlLecture } from "./matrixCore";

describe("matrixCore", () => {
  it("retombe sur le moteur JS si le pont ne répond pas (hors Tauri)", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("pas de Tauri")));
    expect(await moteurMatrix()).toBe("js");
  });

  it("n'active le moteur Rust que sur une réponse explicite", async () => {
    invoke.mockResolvedValue("rust");
    expect(await moteurMatrix()).toBe("rust");
    invoke.mockResolvedValue("autre chose");
    expect(await moteurMatrix()).toBe("js");
  });

  it("passe les arguments de connexion sous les noms attendus par Tauri", async () => {
    invoke.mockResolvedValue(undefined);
    await connecter("sionchat.fr", "moi", "secret");
    expect(invoke).toHaveBeenLastCalledWith("matrix_connecter", {
      serveur: "sionchat.fr",
      identifiant: "moi",
      motDePasse: "secret",
    });
  });

  it("calcule l'heure affichée, absente des messages du cœur", async () => {
    const ts = new Date(2026, 8, 26, 14, 5).getTime();
    invoke.mockResolvedValue([{ salon: "!a:hs", aPlus: true, messages: [{ id: "$1", user: "Alice", role: "user", ts, text: "salut" }] }]);
    const [fil] = await fils();
    expect(fil.messages[0].time).toBe("14:05");
    expect(fil.aPlus).toBe(true);
  });

  it("fait lire un média sion-media par le serveur local, sur toutes les plateformes", async () => {
    invoke.mockResolvedValue(41234);
    expect(await urlLecture("sion-media://localhost/00ff00ff00ff00ff")).toBe("http://127.0.0.1:41234/matrix/00ff00ff00ff00ff");
    expect(await urlLecture("http://sion-media.localhost/00ff00ff00ff00ff?vignette=1")).toBe(
      "http://127.0.0.1:41234/matrix/00ff00ff00ff00ff",
    );
    expect(await urlLecture("https://ailleurs/son.mp3")).toBe("https://ailleurs/son.mp3");
    invoke.mockResolvedValue(0);
    expect(await urlLecture("sion-media://localhost/00ff00ff00ff00ff")).toBeNull();
  });

  it("désigne le salon sous le nom attendu par Tauri", async () => {
    invoke.mockResolvedValue(false);
    expect(await chargerHistorique("!a:hs")).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("matrix_charger_historique", { salon: "!a:hs" });
  });
});
