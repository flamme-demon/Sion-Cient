/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { getCachedRoom, setCachedRoom, appendCachedEventIds, clearCache } from "./messageCache";

const ROOM = "!room:hs";

describe("messageCache (IndexedDB)", () => {
  it("écrit puis relit un cache de salon", async () => {
    await setCachedRoom(ROOM, ["$a", "$b"], "tok1");
    const c = await getCachedRoom(ROOM);
    expect(c).toMatchObject({ roomId: ROOM, eventIds: ["$a", "$b"], paginationToken: "tok1" });
  });

  it("retourne null pour un salon inconnu", async () => {
    expect(await getCachedRoom("!nope:hs")).toBeNull();
  });

  it("appendCachedEventIds fusionne sans doublons et préserve l'ordre", async () => {
    await setCachedRoom(ROOM, ["$a", "$b"], "tok1");
    await appendCachedEventIds(ROOM, ["$b", "$c"], "tok2");
    const c = await getCachedRoom(ROOM);
    expect(c?.eventIds).toEqual(["$a", "$b", "$c"]);
    expect(c?.paginationToken).toBe("tok2");
  });

  it("append sans nouveau token garde l'ancien", async () => {
    await setCachedRoom(ROOM, ["$a"], "tok1");
    await appendCachedEventIds(ROOM, ["$d"], null);
    expect((await getCachedRoom(ROOM))?.paginationToken).toBe("tok1");
  });

  it("clearCache vide tout", async () => {
    await setCachedRoom(ROOM, ["$a"], null);
    await clearCache();
    expect(await getCachedRoom(ROOM)).toBeNull();
  });
});
