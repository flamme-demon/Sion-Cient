import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  moteurMatrix, connecter, fils, chargerHistorique, urlLecture, creerSondage, envoyerFichier, requeteAdmin, ErreurApiAdmin, appareils, detailsSalon,
} from "./matrixCore";

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

  it("passe les options de sondage sous les noms attendus, échéance absente = null", async () => {
    invoke.mockResolvedValue("$s");
    await creerSondage("!a:hs", "On y va ?", ["Oui", "Non"]);
    expect(invoke).toHaveBeenLastCalledWith("matrix_creer_sondage", {
      salon: "!a:hs", question: "On y va ?", options: ["Oui", "Non"], secret: false, max: 1, fin: null,
    });
  });

  it("dépose le fichier en octets bruts puis l'envoie par son chemin", async () => {
    invoke.mockImplementation((commande: string) => Promise.resolve(commande === "stage_media" ? "/tmp/sion-media/x.png" : "$f"));
    const id = await envoyerFichier("!a:hs", new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }));
    expect(id).toBe("$f");
    const depot = invoke.mock.calls.find((c) => c[0] === "stage_media");
    expect(depot?.[1]).toBeInstanceOf(Uint8Array);
    expect(depot?.[2]).toEqual({ headers: { "x-sion-ext": "png" } });
    expect(invoke).toHaveBeenLastCalledWith("matrix_envoyer_fichier", {
      salon: "!a:hs", chemin: "/tmp/sion-media/x.png", nom: "x.png", mime: "image/png", largeur: null, hauteur: null, dureeMs: null,
    });
  });

  it("le mandataire d'administration lève l'erreur d'adminService, errcode compris", async () => {
    invoke.mockResolvedValue({ status: 403, corps: { errcode: "M_FORBIDDEN" } });
    const echec = requeteAdmin("/_continuwuity/admin/rooms/list", { authentifiee: true });
    await expect(echec).rejects.toBeInstanceOf(ErreurApiAdmin);
    await expect(echec).rejects.toMatchObject({ status: 403, errcode: "M_FORBIDDEN" });
    expect(invoke).toHaveBeenLastCalledWith("matrix_requete_admin", {
      methode: "GET", chemin: "/_continuwuity/admin/rooms/list", corps: null, authentifiee: true,
    });
    invoke.mockResolvedValue({ status: 200, corps: { name: "continuwuity", version: "26.9.0" } });
    expect(await requeteAdmin("/_continuwuity/server_version")).toEqual({ name: "continuwuity", version: "26.9.0" });
  });

  it("rend l'infini du créateur d'un salon v12 comme le JS", async () => {
    // i64::MAX tel que JSON.parse le lit : 2⁶³.
    const infini = 2 ** 63;
    invoke.mockResolvedValue({
      membres: [{ userId: "@a:hs", displayName: "A", avatarUrl: null, powerLevel: infini }, { userId: "@b:hs", displayName: "B", avatarUrl: null, powerLevel: 50 }],
      moi: infini, niveauEtat: 50, niveauInvitation: 0, peutEcrire: true, regleAcces: "invite",
    });
    const d = await detailsSalon("!a:hs");
    expect([d.moi, d.membres[0].powerLevel, d.membres[1].powerLevel]).toEqual([Infinity, Infinity, 50]);
  });

  it("rend les appareils sous la forme de getDevices", async () => {
    invoke.mockResolvedValue([{ device_id: "ABC" }]);
    expect(await appareils()).toEqual({ devices: [{ device_id: "ABC" }] });
  });

  it("désigne le salon sous le nom attendu par Tauri", async () => {
    invoke.mockResolvedValue(false);
    expect(await chargerHistorique("!a:hs")).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("matrix_charger_historique", { salon: "!a:hs" });
  });
});
