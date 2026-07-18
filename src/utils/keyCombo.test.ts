import { describe, it, expect } from "vitest";
import { normalizeCombo, keyEventToString, globalComboIssue, formatCombo } from "./keyCombo";

describe("normalizeCombo", () => {
  it("maps legacy letter/digit tokens to physical codes", () => {
    expect(normalizeCombo("Ctrl+A")).toBe("Ctrl+KeyA");
    expect(normalizeCombo("Ctrl+1")).toBe("Ctrl+Digit1");
    expect(normalizeCombo("a")).toBe("KeyA");
  });

  it("passes through already-normalized codes and named keys", () => {
    expect(normalizeCombo("Ctrl+KeyA")).toBe("Ctrl+KeyA");
    expect(normalizeCombo("Backquote")).toBe("Backquote");
    expect(normalizeCombo("Ctrl+Shift+F9")).toBe("Ctrl+Shift+F9");
  });

  it("handles empty and whitespace-padded combos", () => {
    expect(normalizeCombo("")).toBe("");
    expect(normalizeCombo("Ctrl + A")).toBe("Ctrl+KeyA");
  });
});

describe("keyEventToString", () => {
  const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

  it("uses the physical code, modifiers first", () => {
    expect(keyEventToString(ev({ ctrlKey: true, key: "a", code: "KeyQ" }))).toBe("Ctrl+KeyQ");
  });

  it("ignores pure modifier presses", () => {
    expect(keyEventToString(ev({ ctrlKey: true, shiftKey: true, key: "Shift", code: "ShiftLeft" }))).toBe("Ctrl+Shift");
  });

  it("falls back to a normalized key when code is empty (synthetic events)", () => {
    expect(keyEventToString(ev({ key: "a", code: "" }))).toBe("KeyA");
  });
});

describe("globalComboIssue", () => {
  it("rejects empty, bare printable keys, and CEF-stolen F-keys", () => {
    expect(globalComboIssue("")).toBe("empty");
    expect(globalComboIssue("KeyA")).toBe("bare");
    expect(globalComboIssue("Backquote")).toBe("bare");
    expect(globalComboIssue("F12")).toBe("f12");
    expect(globalComboIssue("Ctrl+F12")).toBe("f12");
    expect(globalComboIssue("F5")).toBe("cef-fkey");
  });

  it("accepts modifier combos and free F-keys", () => {
    expect(globalComboIssue("Ctrl+KeyA")).toBeNull();
    expect(globalComboIssue("Ctrl+Shift+Backquote")).toBeNull();
    expect(globalComboIssue("F9")).toBeNull();
    // legacy stored form still validates
    expect(globalComboIssue("Ctrl+A")).toBeNull();
  });
});

describe("formatCombo", () => {
  it("renders codes as readable keys without a layout map", () => {
    expect(formatCombo("Ctrl+KeyA")).toBe("Ctrl+A");
    expect(formatCombo("Ctrl+Digit1")).toBe("Ctrl+1");
    expect(formatCombo("NumpadAdd")).toBe("Num Add");
    expect(formatCombo("Backquote")).toBe("Backquote");
    expect(formatCombo("")).toBe("");
  });
});
