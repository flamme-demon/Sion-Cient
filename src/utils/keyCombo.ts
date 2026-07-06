// Key-combo helpers shared by settings, soundboard hotkeys and the web
// fallback matcher. Combos are stored as PHYSICAL key codes (W3C `e.code`:
// "KeyA", "Digit1", "Backquote", "F9"), joined with "+", modifiers first —
// layout characters like "²" or "Ù" produced by `e.key` can't be registered
// with rdev or the global-shortcut plugin, which both reason in physical keys.

const MODIFIERS = ["Ctrl", "Shift", "Alt", "Meta"];

/** Map a legacy (pre-e.code) token to its physical code; pass codes through. */
function normalizeToken(tok: string): string {
  if (/^[a-z]$/i.test(tok)) return "Key" + tok.toUpperCase();
  if (/^[0-9]$/.test(tok)) return "Digit" + tok;
  return tok;
}

/** Normalize a stored combo (possibly legacy "Ctrl+A") to code form ("Ctrl+KeyA"). */
export function normalizeCombo(combo: string): string {
  if (!combo) return "";
  return combo.split("+").map((t) => t.trim()).filter(Boolean).map(normalizeToken).join("+");
}

export function keyEventToString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
    // e.code is empty for some synthetic events — fall back to the legacy
    // character form, normalized to a code when possible.
    parts.push(e.code || normalizeToken(e.key.length === 1 ? e.key.toUpperCase() : e.key));
  }
  return parts.join("+");
}

// Layout map (Chrome/CEF): translates physical codes back to the character the
// user's layout prints on the key ("Backquote" → "²" on AZERTY). Loaded once,
// best-effort — display falls back to the raw code name until/unless it loads.
let layoutMap: Pick<Map<string, string>, "get"> | null = null;
try {
  (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } })
    .keyboard?.getLayoutMap?.()
    .then((m) => { layoutMap = m; })
    .catch(() => {});
} catch { /* no Keyboard API */ }

/** Human-readable form of a stored combo, for display only. */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  return normalizeCombo(combo).split("+").map((tok) => {
    if (MODIFIERS.includes(tok)) return tok;
    const ch = layoutMap?.get(tok);
    if (ch && ch.length === 1) return ch.toUpperCase();
    if (/^Key[A-Z]$/.test(tok)) return tok.slice(3);
    if (/^Digit[0-9]$/.test(tok)) return tok.slice(5);
    if (/^Numpad/.test(tok)) return tok.replace("Numpad", "Num ");
    return tok;
  }).join("+");
}
