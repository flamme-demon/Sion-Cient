export type WebmVideoCodec = "vp8" | "vp9" | "av1" | "unknown";

/** Detect the Matroska video CodecID without invoking a browser media stack. */
export function detectWebmVideoCodec(bytes: Uint8Array): WebmVideoCodec {
  const hasAscii = (needle: string) => {
    const wanted = new TextEncoder().encode(needle);
    outer: for (let i = 0; i <= bytes.length - wanted.length; i++) {
      for (let j = 0; j < wanted.length; j++) {
        if (bytes[i + j] !== wanted[j]) continue outer;
      }
      return true;
    }
    return false;
  };
  if (hasAscii("V_VP9")) return "vp9";
  if (hasAscii("V_VP8")) return "vp8";
  if (hasAscii("V_AV1")) return "av1";
  return "unknown";
}
