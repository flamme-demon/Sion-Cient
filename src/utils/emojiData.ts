import compactData from "emojibase-data/en/compact.json";
import shortcodes from "emojibase-data/en/shortcodes/github.json";

export interface EmojiEntry {
  shortcode: string;
  emoji: string;
  group: number;
}

// emojibase groups
export const EMOJI_GROUPS: { id: number; label: string; icon: string }[] = [
  { id: 0, label: "Smileys", icon: "😀" },
  { id: 1, label: "People", icon: "👋" },
  { id: 3, label: "Animals & Nature", icon: "🐱" },
  { id: 4, label: "Food & Drink", icon: "🍔" },
  { id: 5, label: "Travel", icon: "✈️" },
  { id: 6, label: "Activities", icon: "⚽" },
  { id: 7, label: "Objects", icon: "💡" },
  { id: 8, label: "Symbols", icon: "❤️" },
  { id: 9, label: "Flags", icon: "🏳️" },
];

// Build a lookup from hexcode → { emoji, group }
const hexToData = new Map<string, { emoji: string; group: number }>();
for (const entry of compactData) {
  hexToData.set(entry.hexcode, { emoji: entry.unicode, group: entry.group ?? -1 });
}

// Build the shortcode → emoji list from GitHub shortcodes (Discord/Slack compatible)
export const EMOJI_DATA: EmojiEntry[] = [];
for (const [hexcode, value] of Object.entries(shortcodes)) {
  const data = hexToData.get(hexcode);
  if (!data || data.group === 2) continue; // skip "Component" group (skin tones etc.)
  const codes = Array.isArray(value) ? value : [value];
  for (const code of codes) {
    EMOJI_DATA.push({ shortcode: code, emoji: data.emoji, group: data.group });
  }
}

// Pre-grouped for the picker
export const EMOJI_BY_GROUP: Map<number, EmojiEntry[]> = new Map();
for (const group of EMOJI_GROUPS) {
  EMOJI_BY_GROUP.set(group.id, EMOJI_DATA.filter((e) => e.group === group.id));
}
