import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { moteurMatrix, connecter } from "./matrixCore";


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
});
