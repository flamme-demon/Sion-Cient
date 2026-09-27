import { describe, it, expect } from "vitest";
import { adresseDeReprise } from "./repriseImages";

describe("reprise des images du cœur Rust", () => {
  it("donne une adresse unique à chaque reprise, format gardé", () => {
    const a = adresseDeReprise("sion-media://localhost/63b23c6039493f82?avatar=1");
    const b = adresseDeReprise("sion-media://localhost/63b23c6039493f82?avatar=1");
    expect(a).toMatch(/^sion-media:\/\/localhost\/63b23c6039493f82\?avatar=1&reprise=\d+$/);
    expect(b).not.toBe(a);
    expect(adresseDeReprise("sion-media://localhost/57d8e7aa4cce04da")).toMatch(/\?reprise=\d+$/);
    expect(adresseDeReprise("http://sion-media.localhost/57d8e7aa4cce04da?vignette=1")).toMatch(/vignette=1&reprise=\d+$/);
  });

  it("une seule reprise, et seulement pour les images du cœur", () => {
    const a = adresseDeReprise("sion-media://localhost/63b23c6039493f82?avatar=1")!;
    expect(adresseDeReprise(a)).toBeNull();
    expect(adresseDeReprise("https://sionchat.fr/_matrix/media/v3/download/x/y")).toBeNull();
    expect(adresseDeReprise("blob:http://localhost:5173/abc")).toBeNull();
  });
});
