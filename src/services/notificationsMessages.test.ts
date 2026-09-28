import { describe, expect, it, vi } from "vitest";

// Les stores lisent localStorage dès leur import.
vi.hoisted(() => {
  const valeurs = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (cle: string) => valeurs.get(cle) ?? null,
    setItem: (cle: string, valeur: string) => { valeurs.set(cle, valeur); },
    removeItem: (cle: string) => { valeurs.delete(cle); },
  } });
});

import { doitNotifier, estMention } from "./notificationsMessages";

const rien = { poke: false, mp: false, mention: false, reponseAMoi: false, salonVocal: false };

describe("doitNotifier", () => {
  it("un poke notifie toujours, même en mode minimal", () => {
    expect(doitNotifier({ ...rien, poke: true }, "minimal")).toBe(true);
  });

  it("mode mentions : MP, mention et réponse, pas le salon vocal", () => {
    expect(doitNotifier({ ...rien, mention: true }, "mentions")).toBe(true);
    expect(doitNotifier({ ...rien, reponseAMoi: true }, "mentions")).toBe(true);
    expect(doitNotifier({ ...rien, mp: true }, "mentions")).toBe(true);
    expect(doitNotifier({ ...rien, salonVocal: true }, "mentions")).toBe(false);
    expect(doitNotifier(rien, "mentions")).toBe(false);
  });

  it("mode minimal : les MP seulement", () => {
    expect(doitNotifier({ ...rien, mp: true }, "minimal")).toBe(true);
    expect(doitNotifier({ ...rien, mention: true }, "minimal")).toBe(false);
  });

  it("mode tout : aussi le salon vocal où l'on est", () => {
    expect(doitNotifier({ ...rien, salonVocal: true }, "all")).toBe(true);
    expect(doitNotifier(rien, "all")).toBe(false);
  });
});

describe("estMention", () => {
  const moi = "@flamme:sionchat.fr";

  it("reconnaît la mention insérée par Sion (@nom affiché)", () => {
    expect(estMention("@flamme 🐐 tu viens ?", undefined, moi, "flamme 🐐")).toBe(true);
    expect(estMention("coucou @Grégory", undefined, "@greg:x", "Grégory")).toBe(true);
  });

  it("reconnaît @partie-locale et un lien vers l'identifiant", () => {
    expect(estMention("hey @flamme", undefined, moi, null)).toBe(true);
    expect(estMention("hey", '<a href="https://matrix.to/#/@flamme:sionchat.fr">flamme</a>', moi, null)).toBe(true);
  });

  it("ne voit pas de mention sans l'un de ces marqueurs", () => {
    expect(estMention("on parle de flamme mais sans arobase", undefined, moi, "flamme 🐐")).toBe(false);
    expect(estMention("@picsou regarde", undefined, moi, "flamme 🐐")).toBe(false);
    expect(estMention("@flamme", undefined, null, null)).toBe(false);
  });
});
