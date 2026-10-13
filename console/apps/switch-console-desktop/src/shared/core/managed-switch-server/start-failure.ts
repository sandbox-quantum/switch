/**
 * A failed start explained in a sentence a person can act on.
 *
 * `line` is the part of the raw error that says what happened, shown as it is
 * so nothing is hidden behind the explanation. `hint` is what to do about it,
 * or null when the error is not one we recognise: then the raw line is all
 * there is, rather than a guess dressed up as advice.
 */
export type StartFailure = {
  line: string;
  hint: string | null;
  /** The host port something else holds, when that is what stopped the start. */
  port: number | null;
};

const MAX_LINE = 240;

const PORT_IN_USE = [
  /bind [^\s]*?:(\d+): address already in use/i,
  /bind for [^\s]*?:(\d+) failed: port is already allocated/i,
  /ports? (?:are|is) not available:.*?:(\d+)/i,
];

const KNOWN: { pattern: RegExp; hint: string }[] = [
  {
    pattern:
      /cannot connect to the docker daemon|is the docker daemon running|docker desktop is not running/i,
    hint: "Docker isn't running. Open Docker Desktop, then try again.",
  },
  {
    pattern: /no space left on device/i,
    hint: 'The disk is full. Free up some space, then try again.',
  },
  {
    pattern:
      /pull access denied|manifest unknown|tls handshake timeout|i\/o timeout|dial tcp|temporary failure in name resolution|net\/http: request canceled/i,
    hint: "The server's images couldn't be downloaded. Check your internet connection, then try again.",
  },
];

function trimLine(line: string): string {
  const flat = line.trim().replace(/\s+/g, ' ');
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
}

/** The line of `error` that matches `pattern`, else the first non-empty one. */
function lineFor(lines: string[], pattern: RegExp | null): string {
  const hit = pattern ? lines.find((line) => pattern.test(line)) : undefined;
  return trimLine(hit ?? lines[0] ?? '');
}

export function explainStartFailure(error: string): StartFailure {
  const lines = error.split('\n').filter((line) => line.trim() !== '');
  for (const pattern of PORT_IN_USE) {
    const match = error.match(pattern);
    if (!match) continue;
    const port = Number(match[1]);
    return {
      line: lineFor(lines, pattern),
      hint: `Another program is using port ${port}. Quit it, or use another port, then try again.`,
      port,
    };
  }
  for (const { pattern, hint } of KNOWN) {
    if (pattern.test(error)) return { line: lineFor(lines, pattern), hint, port: null };
  }
  return { line: lineFor(lines, null), hint: null, port: null };
}
