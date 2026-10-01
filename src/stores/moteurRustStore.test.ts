import { describe, it, expect, vi } from "vitest";
import { conserverInchanges, contexteSionRust } from "./moteurRustStore";

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

describe("événements propres à Sion, côté moteur Rust", () => {
  it("niveau de l'expéditeur : en cache, sinon détails du salon rechargés", async () => {
    const membre = { userId: "@modo:hs", displayName: "Modo", avatarUrl: null, powerLevel: 50 };
    const details = { membres: [membre], moi: 0, niveauEtat: 50, niveauInvitation: 0, peutEcrire: true, regleAcces: null };
    const core = { detailsSalon: vi.fn(async () => details) };
    const enCache: { details?: typeof details } = {};
    const cache = { detailsSalon: vi.fn(() => enCache.details) };
    const get = () => ({ currentUserId: "@moi:hs" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = contexteSionRust(get as any, core as any, cache as any);
    expect(ctx.moi()).toBe("@moi:hs");
    // Cache vide : une éjection doit quand même connaître le niveau réel.
    expect(await ctx.niveau("!s:hs", "@modo:hs")).toBe(50);
    expect(core.detailsSalon).toHaveBeenCalledWith("!s:hs");
    expect(await ctx.niveau("!s:hs", "@inconnu:hs")).toBe(0);
    enCache.details = details;
    expect(ctx.nom("!s:hs", "@modo:hs")).toBe("Modo");
  });
});
