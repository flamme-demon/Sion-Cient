import { describe, expect, it } from "vitest";
import { plainPreview } from "./plainPreview";

describe("plainPreview", () => {
  it("retire les clôtures de bloc de code et les titres", () => {
    // Cas réel : un épinglé s'affichait « ``` ## Download mods at: … ## ## … ».
    const brut = "```\n## Download mods at: https://mod.io/g/anno\n## Disable a mod\n- Add a single `#` before\n```";
    expect(plainPreview(brut)).toBe("Download mods at: https://mod.io/g/anno Disable a mod Add a single # before");
  });

  it("garde le texte d'un lien, jette la cible", () => {
    expect(plainPreview("voir [la doc](https://exemple.fr/page)")).toBe("voir la doc");
  });

  it("ne laisse pas de point d'exclamation orphelin sur une image", () => {
    expect(plainPreview("![capture](https://x/y.png)")).toBe("capture");
  });

  it("retire l'emphase sans toucher au texte", () => {
    expect(plainPreview("**gras** et _italique_ et ~~barré~~")).toBe("gras et italique et barré");
  });

  it("réduit une citation multiligne à une ligne", () => {
    expect(plainPreview("> première\n> seconde")).toBe("première seconde");
  });

  it("rend une chaîne vide pour un corps vide", () => {
    expect(plainPreview("   \n  ")).toBe("");
  });
});
