import { describe, expect, it } from "vitest";
import { lireConnexionQr, texteConnexionQr } from "./connexionQr";

describe("connexionQr", () => {
  const connexion = { serveur: "https://matrix.sionchat.fr", utilisateur: "@flamme:sionchat.fr", jeton: "a+b/c=d&e" };

  it("relit ce qu'il écrit, caractères spéciaux compris", () => {
    const texte = texteConnexionQr(connexion);
    expect(texte.startsWith("sion://connexion?v=1&")).toBe(true);
    expect(lireConnexionQr(texte)).toEqual(connexion);
  });

  it("refuse ce qui n'est pas un QR de connexion Sion", () => {
    expect(lireConnexionQr("https://sionchat.fr")).toBeNull();
    expect(lireConnexionQr("MATRIX\u0002\u0000")).toBeNull();
    // Version inconnue, jeton absent, serveur sans schéma.
    expect(lireConnexionQr("sion://connexion?v=2&s=https%3A%2F%2Fa.fr&t=x")).toBeNull();
    expect(lireConnexionQr("sion://connexion?v=1&s=https%3A%2F%2Fa.fr")).toBeNull();
    expect(lireConnexionQr("sion://connexion?v=1&s=a.fr&t=x")).toBeNull();
  });
});
