import { describe, it, expect } from "vitest";
import { parseMentions } from "./mentions";

const room = (names: Record<string, string>) => ({
  getJoinedMembers: () => Object.entries(names).map(([userId, name]) => ({ userId, name })),
});

const r = room({ "@john:hs": "John", "@johndoe:hs": "John Doe", "@greg:hs": "Grégory D" });

describe("parseMentions", () => {
  it("retourne null sans mention", () => {
    expect(parseMentions("salut tout le monde", r).formattedBody).toBeNull();
    expect(parseMentions("email@picsou.fr", r).mentionedUserIds).toEqual([]);
  });

  it("transforme une mention en lien matrix.to", () => {
    const p = parseMentions("salut @John !", r);
    expect(p.mentionedUserIds).toEqual(["@john:hs"]);
    expect(p.formattedBody).toContain('href="https://matrix.to/#/%40john%3Ahs"');
    expect(p.formattedBody).toContain(">John</a>");
  });

  it("le nom le plus long gagne (@John Doe avant @John)", () => {
    const p = parseMentions("cc @John Doe", r);
    expect(p.mentionedUserIds).toEqual(["@johndoe:hs"]);
  });

  it("gère les noms Unicode et refuse les faux positifs collés", () => {
    expect(parseMentions("yo @Grégory D", r).mentionedUserIds).toEqual(["@greg:hs"]);
    expect(parseMentions("yo @Johnz", r).mentionedUserIds).toEqual([]);
  });

  it("échappe le HTML du texte environnant et convertit les sauts de ligne", () => {
    const p = parseMentions("<b>x</b>\n@John", r);
    expect(p.formattedBody).toContain("&lt;b&gt;x&lt;/b&gt;<br>");
  });

  it("mentionne plusieurs membres, chacun une fois", () => {
    const p = parseMentions("@John et @John Doe et @John", r);
    expect(p.mentionedUserIds.sort()).toEqual(["@john:hs", "@johndoe:hs"]);
  });
});
