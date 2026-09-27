import { describe, it, expect } from "vitest";
import { conserverInchanges } from "./moteurRustStore";

const m = (id: string, text: string) => ({ id, text, ts: 1 });

describe("fil republié par le cœur Rust", () => {
  it("garde l'objet d'un message inchangé, remplace celui qui change", () => {
    const avant = [m("a", "un"), m("b", "deux")];
    const apres = conserverInchanges(avant, [m("a", "un"), m("b", "deux (corrigé)"), m("c", "trois")]);
    expect(apres[0]).toBe(avant[0]);
    expect(apres[1]).not.toBe(avant[1]);
    expect(apres[1].text).toBe("deux (corrigé)");
    expect(apres.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("un fil identique garde son tableau : rien à redessiner", () => {
    const avant = [m("a", "un"), m("b", "deux")];
    expect(conserverInchanges(avant, [m("a", "un"), m("b", "deux")])).toBe(avant);
  });

  it("premier fil ou message retiré : pas de réutilisation hasardeuse", () => {
    const apres = [m("a", "un")];
    expect(conserverInchanges([], apres)).toBe(apres);
    const avant = [m("a", "un"), m("b", "deux")];
    const reduit = conserverInchanges(avant, [m("b", "deux")]);
    expect(reduit).not.toBe(avant);
    expect(reduit[0]).toBe(avant[1]);
  });
});
