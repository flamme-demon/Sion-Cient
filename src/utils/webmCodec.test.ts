import { describe, expect, it } from "vitest";
import { detectWebmVideoCodec } from "./webmCodec";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("detectWebmVideoCodec", () => {
  it.each([
    ["V_VP8", "vp8"],
    ["V_VP9", "vp9"],
    ["V_AV1", "av1"],
  ] as const)("détecte le CodecID %s", (codecId, expected) => {
    expect(detectWebmVideoCodec(bytes(`\u001aEß£metadata:${codecId}:payload`))).toBe(expected);
  });

  it("reste prudent si le CodecID est absent", () => {
    expect(detectWebmVideoCodec(bytes("\u001aEß£metadata"))).toBe("unknown");
  });
});
