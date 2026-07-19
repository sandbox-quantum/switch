/**
 * Wraps injected prompt text in bracketed-paste markers (`ESC[200~ … ESC[201~`).
 *
 * Keystroke-injected messages are written into the agent's TUI as if typed. A
 * TUI runs its per-keystroke handlers on that input, so a raw `@` opens Claude
 * Code's file-path autocomplete and a leading `/` opens the slash-command menu —
 * and the follow-up Enter then selects a menu entry instead of submitting,
 * leaving the message in the box (often with a stray file path glued in).
 * Bracketed paste tells the TUI the bytes are pasted, not typed, so it inserts
 * them literally: no autocomplete, no early submit on embedded newlines, and the
 * whole body commits atomically when the closing marker arrives. The separate
 * submit keystroke sent afterwards is what actually sends it.
 */
export function buildPromptInjectionPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return `\x1b[200~${trimmed}\x1b[201~`;
}
