/**
 * Secret redaction shared by the desktop logger and the tool detail.
 *
 * Pure: no Electron, no file system, no logging. Every pattern is linear — no
 * quantifier is nested inside another over overlapping characters, where a failed match
 * would rescan a run a match starts only at the run's start, and a PEM block and
 * a JWT are found by a scan — so a hostile or merely enormous input cannot make a pass
 * take noticeable time.
 */

export type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

/**
 * A pattern and its replacement. The `RegExp`s are global and shared: use them
 * with `String.prototype.replace` (which resets `lastIndex`), not with `test` or
 * `exec`, whose state would leak between callers.
 */
export type RedactionPattern = readonly [RegExp, RedactionReplacement];

/** The words that mark a value as a credential. */
export const SECRET_KEY_WORDS =
  'authorization|api[_-]?key|private[_-]?key|token|password|passphrase|secret|credential';

/**
 * A credential-bearing key name, with any number of leading qualifier segments.
 *
 * The qualifier prefix is load-bearing, not decoration: a bare `\b` before
 * `token` does not match `bot_token`, because `_` is a word character and there
 * is no boundary inside it. Real config keys are almost always qualified —
 * `bot_token`, `app_token`, `admin_password`, `client_secret` — so without this
 * the alternation only caught the unqualified spelling nobody uses.
 */
export const SECRET_KEY_NAMES = `(?:[a-z0-9]+[_-])*(?:${SECRET_KEY_WORDS})`;

/**
 * Where an unquoted key name may start: not inside a qualifier chain, so the
 * chain is scanned once from its start, not again from every segment of it
 * (`\b` lets each `a-` of `a-a-a-…` start a scan to the end, which is
 * quadratic). A letter of a JSON escape (`\n`, `\r`, `\t`) is not part of a
 * chain: a key on the next line of a serialized string starts after it.
 */
const KEY_START = String.raw`(?<![a-z0-9](?<!\\[nrt])[_-]?)`;

/**
 * Where a token may start: at a word boundary, or right after a JSON escape
 * (`\n`, `\r`, `\t`), whose letter would otherwise hide the boundary when a
 * token on the next line of a string is serialized.
 */
const TOKEN_START = String.raw`(?:\b|(?<=\\[nrt]))`;

/**
 * The body of a JSON string: any character but a quote or backslash, or a
 * backslash escape (`\n`, `\"`, `\\`, `\u…`). The two branches cannot both
 * match the same character, so the repetition stays linear.
 */
const JSON_STRING_BODY = String.raw`(?:[^"\\]|\\.)*`;

/**
 * The body of a JSON string that is itself inside a JSON string, so every quote
 * and backslash of the inner document carries one more escape: the inner
 * `alpha\nbeta` reads `alpha\\nbeta`, and an inner `\"` reads `\\\"`. The
 * closing quote is the only `\"` not preceded by an escaped backslash. A single
 * escape (`\n` for a raw newline in the inner text) is accepted as well; each
 * branch starts on a different character pair, so this too stays linear.
 */
const ESCAPED_JSON_STRING_BODY = String.raw`(?:[^"\\]|\\\\(?:\\["\\]|[^"\\])|\\[^"\\])*`;

/**
 * A quoted value after `key=` or `key:`, which may contain spaces. Each quote
 * kind runs to its own closing quote on the same line; a backslash escapes the
 * next character.
 */
const QUOTED_VALUE = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;

/**
 * A quoted value whose quotes are themselves escaped, as it appears inside a
 * JSON string: `password=\"abc def\"`. It runs to the closing escaped quote of
 * its own kind on the same line; any other backslash pair (`\\`, `\n`) is taken
 * as one unit, so the closing `\"` is never mistaken for body. Each branch starts
 * on a different character, so the repetition stays linear.
 */
const ESCAPED_QUOTED_VALUE = String.raw`\\"(?:[^"\\\n]|\\[^"\n])*\\"|\\'(?:[^'\\\n]|\\[^'\n])*\\'`;

/**
 * A quoted value with no closing quote of its kind on its line: the opening
 * quote and the rest of the line. Tried only after `QUOTED_VALUE` has failed,
 * so a value that closes keeps its quotes; one that does not is masked to the
 * line's end rather than shown.
 */
const UNCLOSED_QUOTED_VALUE = String.raw`["'][^\r\n]*`;

/**
 * An escaped quoted value with no closing escaped quote of its kind on its
 * line, as inside a JSON string: the escaped opening quote, then every
 * character up to the line's end or a bare quote, which ends the enclosing
 * string (so a JSON log line stays JSON). A backslash pair (`\"`, `\n`) is
 * taken as one unit, never as that bare quote. Each branch starts on a
 * different character, so the repetition stays linear.
 */
const UNCLOSED_ESCAPED_QUOTED_VALUE = String.raw`\\["'](?:[^"\\\r\n]|\\[^\r\n])*`;

/**
 * An unquoted value: runs to whitespace, a comma, a quote or a closing brace. A
 * backslash belongs to the value (`domain\user`) unless it starts an escaped
 * quote: inside a JSON string the line's own quotes are escapes
 * (`\"Authorization: Bearer x\"`), and taking the backslash would leave a bare
 * quote that ends the string early. The two branches start on different
 * characters, so the repetition stays linear.
 */
const UNQUOTED_VALUE = String.raw`(?:[^\s,"'}\\]|\\(?!["']))+`;

/** A token shape: `body` from where a token may start to a word boundary. */
function token(body: string): RegExp {
  return new RegExp(String.raw`${TOKEN_START}${body}\b`, 'g');
}

/** The PEM armor lines a block starts and ends with, as expression sources. */
export const PEM_BEGIN_SOURCE = '-----BEGIN[^-\\n]{1,40}-----';
export const PEM_END_SOURCE = '-----END[^-\\n]{1,40}-----';
const PEM_BLOCK_SOURCE = `${PEM_BEGIN_SOURCE}[\\s\\S]+?${PEM_END_SOURCE}`;

/**
 * A pattern found by a scan rather than by the `RegExp` engine. A `RegExp`
 * whose `exec` does the scan, so `String.prototype.replace`, `matchAll` and
 * every caller of the pattern list use it as they use the others. The source is
 * the expression the scan stands for; it is what `exec` would find, not what it
 * runs.
 */
abstract class ScanPattern extends RegExp {
  /** The `[start, stop)` of the first match at or after `from`, or `null`. */
  protected abstract find(text: string, from: number): readonly [number, number] | null;

  override exec(text: string): RegExpExecArray | null {
    const found = this.find(text, this.global ? this.lastIndex : 0);
    if (found === null) {
      if (this.global) this.lastIndex = 0;
      return null;
    }
    const [start, stop] = found;
    const match = [text.slice(start, stop)] as unknown as RegExpExecArray;
    match.index = start;
    match.input = text;
    match.groups = undefined;
    if (this.global) this.lastIndex = stop;
    return match;
  }
}

/**
 * A PEM block: a `BEGIN` armor line, at least one character, and the nearest
 * `END` armor line after it — what
 * `/-----BEGIN[^-\n]{1,40}-----[\s\S]+?-----END[^-\n]{1,40}-----/g` matches,
 * found by a linear scan instead. That expression retries from every later
 * `BEGIN` when no `END` follows, rescanning the rest of the text each time,
 * which is quadratic. Here a `BEGIN` with no `END` after it ends the search:
 * any later `BEGIN` ends further on, so no `END` follows it either.
 */
class PemBlockPattern extends ScanPattern {
  constructor(source: string | RegExp = PEM_BLOCK_SOURCE, flags = 'g') {
    super(source, flags);
  }

  protected find(text: string, from: number): readonly [number, number] | null {
    const begin = new RegExp(PEM_BEGIN_SOURCE, 'g');
    begin.lastIndex = from;
    const opened = begin.exec(text);
    if (opened === null) return null;
    const end = new RegExp(PEM_END_SOURCE, 'g');
    end.lastIndex = opened.index + opened[0].length + 1;
    const closed = end.exec(text);
    if (closed === null) return null;
    return [opened.index, closed.index + closed[0].length];
  }
}

/** The expression the JWT scan stands for: three segments, from where a token may start. */
const JWT_SOURCE = String.raw`${TOKEN_START}eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`;

/** Whether the UTF-16 code `code` is a word character (`\w`); `NaN`, past either end, is not. */
function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** Whether the UTF-16 code `code` is a JWT character (`[A-Za-z0-9_-]`). */
function isJwtCode(code: number): boolean {
  return isWordCode(code) || code === 45;
}

/** Where the run of JWT characters at `from` ends: the first index at or after it that is not one. */
function jwtRunEnd(text: string, from: number): number {
  let index = from;
  while (isJwtCode(text.charCodeAt(index))) index++;
  return index;
}

/** Whether `\b` holds at `index`: a word character on exactly one side of it. */
function isWordBoundary(text: string, index: number): boolean {
  return isWordCode(text.charCodeAt(index - 1)) !== isWordCode(text.charCodeAt(index));
}

/**
 * A JWT: what `JWT_SOURCE` matches — `eyJ` at a word boundary (also after a
 * `-`) or right after a JSON escape, three dot-separated segments of at least
 * eight `[A-Za-z0-9_-]`, the first two after `eyJ`, and a word boundary at the
 * end — found by a linear scan instead. The expression tries every `eyJ` of a
 * run of `eyJaaa…-eyJaaa…-…` and scans each to the end of the run, which is
 * quadratic. Here each run's end is found once: no segment can hold a dot, so
 * the first segment of every start in a run ends at the run's end, the next two
 * segments are the same for all of them, and the first start, whose first
 * segment is the longest, is the only one that can match. When it does not, the
 * search goes on after the run.
 */
class JwtPattern extends ScanPattern {
  constructor(source: string | RegExp = JWT_SOURCE, flags = 'g') {
    super(source, flags);
  }

  protected find(text: string, from: number): readonly [number, number] | null {
    let index = from;
    for (;;) {
      const start = text.indexOf('eyJ', index);
      if (start < 0) return null;
      if (!JwtPattern.mayStart(text, start)) {
        index = start + 1;
        continue;
      }
      const runEnd = jwtRunEnd(text, start + 3);
      const stop = JwtPattern.end(text, start, runEnd);
      if (stop >= 0) return [start, stop];
      index = runEnd;
    }
  }

  /** `TOKEN_START` at `start`: a word boundary before its `e`, or a JSON escape. */
  private static mayStart(text: string, start: number): boolean {
    if (!isWordCode(text.charCodeAt(start - 1))) return true;
    return start >= 2 && text[start - 2] === '\\' && 'nrt'.includes(text[start - 1]!);
  }

  /** Where the JWT at `start`, whose first segment runs to `runEnd`, ends; -1 when there is none. */
  private static end(text: string, start: number, runEnd: number): number {
    if (runEnd - (start + 3) < 8 || text[runEnd] !== '.') return -1;
    const second = runEnd + 1;
    if (!text.startsWith('eyJ', second)) return -1;
    const secondEnd = jwtRunEnd(text, second + 3);
    if (secondEnd - (second + 3) < 8 || text[secondEnd] !== '.') return -1;
    const third = secondEnd + 1;
    // The last segment gives back characters, as the expression's greedy
    // quantifier does, until a word boundary ends it.
    for (let stop = jwtRunEnd(text, third); stop >= third + 8; stop--) {
      if (isWordBoundary(text, stop)) return stop;
    }
    return -1;
  }
}

/**
 * A JSON string value with no closing quote: the opening quote and the rest of
 * the line. Tried only after the closed form has failed.
 */
const UNCLOSED_JSON_STRING = String.raw`"[^\r\n]*`;

/**
 * An escaped JSON string value with no closing escaped quote, as inside another
 * JSON string: the escaped opening quote, then every character up to the
 * line's end or a bare quote, which ends the enclosing string. A backslash pair
 * is taken as one unit; each branch starts on a different character, so the
 * repetition stays linear.
 */
const UNCLOSED_ESCAPED_JSON_STRING = String.raw`\\"(?:[^"\\\r\n]|\\[^\r\n])*`;

/**
 * A JSON key/value pattern: the quoted key `"key"` (or `\"key\"` when
 * `escapedKey`), the separator and the value, closed or not. A closed value is
 * redacted between its quotes; one that does not close is redacted from its
 * opening quote to the line's end (the escaped kind also to a bare quote).
 */
function jsonKeyPattern(escapedKey: boolean, escapedValue: boolean): RedactionPattern {
  // The quote as the regular expression matches it, and as the text has it.
  const keySource = escapedKey ? String.raw`\\"` : '"';
  const keyQuote = escapedKey ? '\\"' : '"';
  const valueQuote = escapedValue ? '\\"' : '"';
  const closed = escapedValue
    ? String.raw`\\"${ESCAPED_JSON_STRING_BODY}\\"`
    : `"${JSON_STRING_BODY}"`;
  const unclosed = escapedValue ? UNCLOSED_ESCAPED_JSON_STRING : UNCLOSED_JSON_STRING;
  return [
    new RegExp(
      String.raw`${keySource}(${SECRET_KEY_NAMES})${keySource}(\s*:\s*)(?:${closed}|(${unclosed}))`,
      'gi'
    ),
    (_match, keyName: string, separator: string, open: string | undefined) =>
      `${keyQuote}${keyName}${keyQuote}${separator}${valueQuote}[REDACTED]${open ? '' : valueQuote}`,
  ];
}

const SECRET_PATTERN_LIST: RedactionPattern[] = [
  // JSON-quoted key/value: "key":"value". The value may contain escapes, so
  // `{"password":"alpha\nbeta"}` and an embedded `\"` are redacted whole.
  jsonKeyPattern(false, false),
  // The same document escaped once more, as it appears inside another JSON
  // string: \"key\":\"value\".
  jsonKeyPattern(true, true),
  // The two mixed: a plain key with an escaped value, "key":\"value\", and an
  // escaped key with a plain value, \"key\":"value", as a line put together
  // from both kinds of text has them.
  jsonKeyPattern(false, true),
  jsonKeyPattern(true, false),
  // Unquoted: key=value, or key: <scheme> value. The scheme alternation must
  // stay in step with the auth schemes we might log: without `bot`, Discord's
  // `Authorization: Bot <token>` redacts the word "Bot" and leaves the token,
  // and without `basic`, `Authorization: Basic <base64>` keeps the credential.
  // A quoted value (`password="alpha beta"`) is redacted to its closing quote,
  // keeping the quotes so the line still reads as an assignment; an escaped
  // quoted value (`password=\"alpha beta\"` inside a JSON string) likewise
  // keeps its escaped quotes. A quoted value that does not close on its line
  // is redacted from its opening quote to the line's end (the escaped kind
  // also to a bare quote, the end of its JSON string).
  [
    new RegExp(
      `${KEY_START}(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(?:(${QUOTED_VALUE})|(${ESCAPED_QUOTED_VALUE})|(${UNCLOSED_QUOTED_VALUE})|(${UNCLOSED_ESCAPED_QUOTED_VALUE})|(?:(?:bearer|bot|token|basic)\\s+)?${UNQUOTED_VALUE})`,
      'gi'
    ),
    (
      _match,
      keyName: string,
      separator: string,
      quoted: string | undefined,
      escapedQuoted: string | undefined,
      unclosed: string | undefined,
      escapedUnclosed: string | undefined
    ) => {
      if (quoted) {
        const quote = quoted[0];
        return `${keyName}${separator}${quote}[REDACTED]${quote}`;
      }
      if (escapedQuoted) {
        const quote = escapedQuoted.slice(0, 2);
        return `${keyName}${separator}${quote}[REDACTED]${quote}`;
      }
      if (unclosed) return `${keyName}${separator}${unclosed[0]}[REDACTED]`;
      if (escapedUnclosed) return `${keyName}${separator}${escapedUnclosed.slice(0, 2)}[REDACTED]`;
      return `${keyName}${separator}[REDACTED]`;
    },
  ],
  // PEM blocks (private keys)
  [new PemBlockPattern(), '[REDACTED_PEM_BLOCK]'],
  // Known token prefixes — order matters: vendor-specific before generic
  [token(String.raw`gh[opsu]_[A-Za-z0-9]{36,255}`), '[REDACTED_GITHUB_TOKEN]'],
  [token(String.raw`glpat-[A-Za-z0-9_-]{20,}`), '[REDACTED_GITLAB_TOKEN]'],
  [token(String.raw`npm_[A-Za-z0-9]{36,}`), '[REDACTED_NPM_TOKEN]'],
  [token(String.raw`AKIA[0-9A-Z]{16}`), '[REDACTED_AWS_KEY]'],
  [token(String.raw`(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`), '[REDACTED_STRIPE_KEY]'],
  [token(String.raw`sk-ant-[A-Za-z0-9_-]{20,}`), '[REDACTED_ANTHROPIC_KEY]'],
  [token(String.raw`sk-[A-Za-z0-9_-]{20,}`), '[REDACTED_OPENAI_KEY]'],
  // `xoxe` is a rotating/refresh token; `xapp` is an app-level token, which a
  // Slack bridge needs alongside the bot token for Socket Mode.
  [token(String.raw`(?:xox[abepprs]|xapp)-[A-Za-z0-9-]{15,}`), '[REDACTED_SLACK_TOKEN]'],
  [new JwtPattern(), '[REDACTED_JWT]'],
  // Discord bot token: base64 client id . 6-char timestamp . hmac. Unprefixed,
  // so it is matched structurally. Kept after the JWT rule, whose middle
  // segment is far longer than six characters, so the two cannot collide.
  [
    token(String.raw`[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`),
    '[REDACTED_DISCORD_TOKEN]',
  ],
  // Telegram bot token: numeric bot id : 35-char hmac. Also unprefixed, so it
  // is matched structurally. The colon keeps it clear of the Discord rule.
  [token(String.raw`\d{6,12}:[A-Za-z0-9_-]{30,}`), '[REDACTED_TELEGRAM_TOKEN]'],
];

/** The patterns `redactSecrets` applies, in order. */
export const SECRET_PATTERNS: readonly RedactionPattern[] = Object.freeze(SECRET_PATTERN_LIST);

/**
 * Any scheme://user:pass@ — covers postgres, mongodb, redis, mysql, amqp, https…
 * — and scheme://:pass@ with an empty user, as a Redis URL with only a password
 * is written.
 *
 * Anchored on `://` with one scheme character right before it (a lookbehind
 * of constant length), not on where the scheme starts: the scheme stays in
 * the text as it is, so a URL after `+`, `-` or `.` (a diff line,
 * `x-https://…`) is found too, and no run of scheme characters is scanned
 * from each of its positions, which would be quadratic. Each attempt that
 * gets past `://` stops at the next `/`, so matching stays linear.
 *
 * Deliberately not part of `redactSecrets`: the desktop log keeps it on disk
 * for local debugging and removes it with the rest of its personal data on
 * export. Callers that never keep the text locally apply it directly.
 */
export const URL_CREDENTIALS_PATTERN: RedactionPattern = Object.freeze([
  /(?<=[a-z0-9+.-]):\/\/[^\s:/?#@]*:[^\s@/?#]+@/gi,
  '://[REDACTED_CREDENTIALS]@',
] as const);

export function applyRedactions(value: string, patterns: readonly RedactionPattern[]): string {
  return patterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement as string),
    value
  );
}

/** Removes credentials: keyed values, PEM blocks and known token shapes. */
export function redactSecrets(value: string): string {
  return applyRedactions(value, SECRET_PATTERNS);
}

/** Removes the `user:password` part of `scheme://user:password@host`. */
export function redactUrlCredentials(value: string): string {
  return applyRedactions(value, [URL_CREDENTIALS_PATTERN]);
}

/** A `[start, end)` range of UTF-16 code units a pattern would replace, and its marker. */
export interface SecretRange {
  start: number;
  end: number;
  /** The marker the pattern writes there: `[REDACTED]` or a labelled one. */
  marker: string;
}

const REPLACEMENT_MARKER = /\[REDACTED[A-Z_]*\]/;

/** What `replacement` writes for `match`, as `String.prototype.replace` would. */
function replaced(match: RegExpExecArray, replacement: RedactionReplacement): string {
  if (typeof replacement === 'function')
    return replacement(match[0], ...(match.slice(1) as string[]), String(match.index));
  return replacement.replace(/\$(\d)/g, (_, group: string) => match[Number(group)] ?? '');
}

/**
 * The range of `match` a pattern's replacement hides: the match without the
 * text the replacement keeps before and after its marker (a key name, its
 * separator, quotes), or the whole match when the replacement does not keep
 * the match's own start and end.
 */
function secretRangeOf(match: RegExpExecArray, replacement: RedactionReplacement): SecretRange {
  const whole = match[0];
  const start = match.index;
  const written = replaced(match, replacement);
  const marker = REPLACEMENT_MARKER.exec(written);
  if (!marker) return { start, end: start + whole.length, marker: '[REDACTED]' };
  const before = written.slice(0, marker.index);
  const after = written.slice(marker.index + marker[0].length);
  const kept =
    before.length + after.length <= whole.length &&
    whole.startsWith(before) &&
    whole.endsWith(after);
  return kept
    ? { start: start + before.length, end: start + whole.length - after.length, marker: marker[0] }
    : { start, end: start + whole.length, marker: marker[0] };
}

/**
 * Where each of `patterns` would replace a secret in `value`, every pattern
 * searched in the same text (not in the text an earlier one has already
 * redacted, as `applyRedactions` does): the secret part only, so a caller can
 * merge these with ranges of its own and mask the text once. Ranges may
 * overlap; one inside a range of an earlier pattern is left out, and so is an
 * empty one (an empty quoted value): there is nothing more to hide.
 */
export function secretRanges(
  value: string,
  patterns: readonly RedactionPattern[] = SECRET_PATTERNS
): SecretRange[] {
  const ranges: SecretRange[] = [];
  for (const [pattern, replacement] of patterns) {
    // A match inside what an earlier pattern hides is one `applyRedactions`
    // would not find: the label (`sk-ant-…` before `sk-…`) stays the earlier
    // one's. Matches come in order, so one pass over the earlier ranges sorted
    // by start, with the furthest end so far, tells.
    const earlier = [...ranges].sort((left, right) => left.start - right.start);
    let next = 0;
    let furthest = -1;
    for (const match of value.matchAll(pattern)) {
      const range = secretRangeOf(match as RegExpExecArray, replacement);
      if (range.end <= range.start) continue;
      while (next < earlier.length && earlier[next]!.start <= range.start)
        furthest = Math.max(furthest, earlier[next++]!.end);
      if (furthest < range.end) ranges.push(range);
    }
  }
  return ranges;
}
