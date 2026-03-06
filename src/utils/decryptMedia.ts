/**
 * Décryption des médias E2EE Matrix (spec v2).
 *
 * Les fichiers chiffrés utilisent AES-256-CTR.
 * Référence : https://spec.matrix.org/v1.11/client-server-api/#sending-encrypted-attachments
 */

export interface EncryptedMediaFile {
  url: string;
  key: {
    alg: string;
    key_ops: string[];
    kty: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: Record<string, string>;
  v: string;
}

function base64urlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function decryptMedia(encryptedData: ArrayBuffer, encFile: EncryptedMediaFile): Promise<ArrayBuffer> {
  const ivBytes = base64urlToBytes(encFile.iv);
  // Garantir un ArrayBuffer pur (pas SharedArrayBuffer) pour Web Crypto
  const ivBuffer = ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer;

  const key = await crypto.subtle.importKey(
    "jwk",
    { ...encFile.key, key_ops: ["decrypt"] },
    { name: "AES-CTR", length: 256 },
    false,
    ["decrypt"],
  );

  return crypto.subtle.decrypt(
    { name: "AES-CTR", counter: new Uint8Array(ivBuffer), length: 64 },
    key,
    encryptedData,
  );
}

/** Télécharge, décrypte et retourne un Object URL blob prêt à l'emploi. */
export async function createDecryptedObjectUrl(
  httpUrl: string,
  encFile: EncryptedMediaFile,
  mimeType: string,
): Promise<string> {
  const response = await fetch(httpUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${httpUrl}`);
  const encryptedData = await response.arrayBuffer();
  const decrypted = await decryptMedia(encryptedData, encFile);
  const blob = new Blob([decrypted], { type: mimeType });
  return URL.createObjectURL(blob);
}
