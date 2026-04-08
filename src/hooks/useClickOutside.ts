import { useEffect, type RefObject } from "react";

/**
 * Calls `onOutside` whenever a pointerdown happens outside the referenced
 * element. Targets carrying `data-panel-toggle` (or any of their ancestors)
 * are ignored, so the very button that toggles the panel doesn't fight with
 * the outside-click handler.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  active: boolean = true,
): void {
  useEffect(() => {
    if (!active) return;

    const handler = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (el.contains(target)) return;
      // Exempt toggle buttons so they keep working without flicker
      if (target instanceof Element && target.closest("[data-panel-toggle]")) return;
      onOutside();
    };

    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [ref, onOutside, active]);
}
