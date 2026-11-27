/**
 * Reading what a provider CLI's own sign-in command writes: the page to sign
 * in on, a code to type there, whether it waits for one pasted back, and the
 * login it ends with. Shared by Switch Console, which runs the command on
 * this computer, and the agent controller, which runs it on its machine for
 * a browser sign-in started from Switch.
 */

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;
/** Punctuation that ends a sentence around a link rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
/** This computer's own addresses: a CLI's callback server, which is no page to sign in on. */
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/**
 * The sign-in pages a command printed, in order and without repeats. Codex,
 * for one, also prints the local server its browser round trip calls back to,
 * which is left out, as is the full stop a sentence ends a link with.
 */
export function linksIn(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines)
    for (const match of line.matchAll(URL_PATTERN)) {
      const link = match[0].replace(TRAILING_PUNCTUATION, '');
      let host: string;
      try {
        host = new URL(link).hostname;
      } catch {
        continue;
      }
      if (!LOOPBACK_HOST.test(host)) seen.add(link);
    }
  return [...seen];
}

const ASKS_FOR_CODE = /paste (the )?(authentication |authorization |auth )?code/i;
/** An authorize link for the flow that ends on a page showing a code to paste. */
const CODE_FLOW_LINK = /[?&]code=true(&|$)/;

/**
 * Whether the command may wait for a code typed in. Claude Code's sign-in
 * page can end by showing one to paste, when its callback to this computer did
 * not happen; it asks with a prompt that ends no line (so it arrives only once
 * the code is sent), after printing the link for that flow. Antigravity's
 * `agy acp --login` always asks for one.
 */
export function asksForCode(lines: readonly string[]): boolean {
  return (
    lines.some((line) => ASKS_FOR_CODE.test(line)) ||
    linksIn(lines).some((link) => CODE_FLOW_LINK.test(link))
  );
}

/** An OSC 8 hyperlink's opening, whose target is kept: it is whole however the text wraps. */
const HYPERLINK = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OTHER_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Moving the cursor right or to a column: a gap between words in a TUI's frame. */
const CURSOR_ACROSS = /\x1b\[\d*[CG]/g;
const OTHER_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OTHER_ESCAPE = /\x1b[@-_78]/g;

/**
 * What a terminal shows of `raw`: escape sequences dropped, the cursor moves
 * a TUI lays words out with read as spaces, and a hyperlink's target kept
 * beside its text.
 */
export function terminalText(raw: string): string {
  return raw
    .replace(HYPERLINK, (_all, target: string) => (target ? ` ${target} ` : ' '))
    .replace(OTHER_OSC, '')
    .replace(CURSOR_ACROSS, ' ')
    .replace(OTHER_CSI, '')
    .replace(OTHER_ESCAPE, '');
}

/** `text` in lines, however the terminal ended them. */
export function linesOf(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** A device code as Codex and OpenCode show one to type on its page: `ABCD-12345`. */
const DEVICE_CODE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;

/** The one-time code a device sign-in prints to type on its page, or null. */
export function deviceCodeIn(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (/https?:\/\//.test(line)) continue;
    const match = DEVICE_CODE.exec(line);
    if (match) return match[0];
  }
  return null;
}

/** A long-lived token `claude setup-token` prints once the sign-in is done. */
const SETUP_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/g;

/** The setup token in `text`, the last one printed, or null. */
export function setupTokenIn(text: string): string | null {
  const found = text.match(SETUP_TOKEN);
  return found ? found[found.length - 1]! : null;
}
