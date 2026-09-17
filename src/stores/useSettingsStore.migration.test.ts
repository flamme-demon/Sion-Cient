import { describe, expect, it } from "vitest";
import { migrateSettingsState } from "./useSettingsStore";

describe("migration sion-settings v0 → v1", () => {
  it("conserve les réglages et complète les cues absents", () => {
    const customJoin = {
      path: "/data/cues/cue_123.wav",
      start: 0.25,
      end: 1.5,
      gain: 0.8,
    };
    const migrated = migrateSettingsState({
      language: "fr",
      voiceSounds: { join: customJoin },
    });

    expect(migrated.language).toBe("fr");
    expect(migrated.voiceSounds?.join).toEqual(customJoin);
    expect(migrated.voiceSounds?.memberKicked).toBeNull();
    expect(migrated.voiceSounds?.undeafen).toBeNull();
  });

  it("répare un snapshot sans objet voiceSounds", () => {
    const migrated = migrateSettingsState({ voiceSounds: null, screenShareAudio: false });
    expect(migrated.screenShareAudio).toBe(false);
    expect(Object.keys(migrated.voiceSounds ?? {})).toHaveLength(10);
  });
});
