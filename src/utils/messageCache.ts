/**
 * Lightweight IndexedDB cache for message event IDs per room.
 * Stores only event IDs + pagination token — not full message content.
 * Works on both desktop (CEF/WRY) and mobile (Android WebView).
 */

const DB_NAME = "sion-message-cache";
const DB_VERSION = 1;
const STORE_NAME = "room-messages";

interface RoomCache {
  roomId: string;
  eventIds: string[];
  paginationToken: string | null;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "roomId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function getCachedRoom(roomId: string): Promise<RoomCache | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(roomId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function setCachedRoom(
  roomId: string,
  eventIds: string[],
  paginationToken: string | null,
): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const data: RoomCache = { roomId, eventIds, paginationToken, updatedAt: Date.now() };
      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail — cache is optional
  }
}

export async function appendCachedEventIds(
  roomId: string,
  newEventIds: string[],
  paginationToken: string | null,
): Promise<void> {
  const existing = await getCachedRoom(roomId);
  const existingIds = new Set(existing?.eventIds ?? []);
  const merged = [...(existing?.eventIds ?? [])];
  for (const id of newEventIds) {
    if (!existingIds.has(id)) {
      merged.push(id);
      existingIds.add(id);
    }
  }
  await setCachedRoom(roomId, merged, paginationToken ?? existing?.paginationToken ?? null);
}

export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
}
