/**
 * Wraps injected prompt text in bracketed-paste markers (`ESC[200~ … ESC[201~`)
 * with a trailing space inside the paste.
 *
 * Keystroke-injected messages are written into the agent's TUI as if typed. A
 * TUI runs its per-keystroke handlers on that input, so a raw `@` opens Claude
 * Code's file-path autocomplete and a leading `/` opens the slash-command menu —
 * and the follow-up Enter then selects a menu entry instead of submitting,
 * leaving the message in the box (often with a stray file path glued in).
 * Bracketed paste tells the TUI the bytes are pasted, not typed, so it inserts
 * them literally: no per-key autocomplete, no early submit on embedded newlines,
 * and the whole body commits atomically when the closing marker arrives.
 *
 * Bracketing alone is not enough when the body *ends* with an `@mention` (Switch
 * addressed messages routinely do): after the paste settles the cursor sits
 * right after the `@token`, so Claude reopens the file picker on that token and
 * the follow-up Enter selects a completion (CHOO-1395). The trailing space —
 * placed inside the paste so it is inserted literally and can never be read as an
 * "accept" keystroke — terminates that token, leaving the cursor past it so no
 * picker is open when the separate submit keystroke lands.
 */
/**
 * Strip C0/C1 control bytes (keeping tab and newline) from untrusted text.
 *
 * The injected text comes from room messages, which any participant can write.
 * Removing control bytes — ESC in particular — means an embedded bracketed-paste
 * end marker (`ESC[201~`) or any other escape sequence cannot survive to close
 * the paste early and turn the rest of the message into live keystrokes. Tab and
 * newline are kept so multi-line pasted content is preserved.
 */
function stripControlBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function buildPromptInjectionPayload(text: string): string {
  const trimmed = stripControlBytes(text).trim();
  if (!trimmed) return '';
  return `\x1b[200~${trimmed} \x1b[201~`;
}
