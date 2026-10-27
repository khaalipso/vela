// The keys as the platform writes them: ⌘ ⇧ ⌥ on macOS, Ctrl Shift Alt elsewhere.

export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** `Ctrl Shift K` → `⌘⇧K` on macOS; unchanged elsewhere. */
export function keyText(k: string, mac = isMac): string {
  if (!mac) return k;
  return k
    .replace(/\bCtrl\b ?/g, "⌘")
    .replace(/\bShift\b ?/g, "⇧")
    .replace(/\bAlt\b ?/g, "⌥");
}
