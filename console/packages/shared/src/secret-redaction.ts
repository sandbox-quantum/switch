/**
 * Secrets recognised by their shape, wherever they are written: what the
 * desktop log removes before an entry reaches disk, and what a session host
 * removes from a tool call before a room is shown it. One set, so a pattern
 * fixed for one is fixed for both.
 */

/** The words that mark a value as a credential. */
const SECRET_KEY_WORDS =
  'authorization|api[_-]?key|private[_-]?key|secret[_-]?(?:access[_-]?)?key|access[_-]?key|token|password|passwd|passphrase|secret|credential';

/**
 * A credential-bearing key name, with any number of leading qualifier segments.
 *
 * The qualifier prefix is load-bearing, not decoration: a bare `\b` before
 * `token` does not match `bot_token`, because `_` is a word character and there
 * is no boundary inside it. Real config keys are almost always qualified —
 * `bot_token`, `app_token`, `admin_password`, `client_secret` — so without this
 * the alternation only caught the unqualified spelling nobody uses.
 */
const SECRET_KEY_NAMES = `(?:[a-z0-9]+[_-])*(?:${SECRET_KEY_WORDS})`;

export type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

const SECRET_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
  // JSON-quoted key/value: handles both "key":"value" and escaped \"key\":\"value\"
  [
    new RegExp(`(\\\\?")(${SECRET_KEY_NAMES})(\\\\?")(\\s*:\\s*)\\\\?"[^"\\\\]*\\\\?"`, 'gi'),
    (_match, openQuote: string, keyName: string, closeQuote: string, separator: string) =>
      `${openQuote}${keyName}${closeQuote}${separator}${openQuote}[REDACTED]${openQuote}`,
  ],
  // A shell, env or YAML value in quotes: the whole of it, spaces included, to
  // its closing quote, or to the end of the line when a cut took the quote.
  [
    new RegExp(
      `\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3)[^\\\\\\n])+(\\3|$)`,
      'gim'
    ),
    '$1$2$3[REDACTED]$4',
  ],
  // Unquoted: key=value, or key: <scheme> value. The scheme alternation must
  // stay in step with the auth schemes we might log: without `bot`, Discord's
  // `Authorization: Bot <token>` redacts the word "Bot" and leaves the token.
  [
    new RegExp(
      `\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(?:(?:bearer|basic|bot|token)\\s+)?[^\\s,"'}]+`,
      'gi'
    ),
    '$1$2[REDACTED]',
  ],
  // A command-line flag and its value: `--password hunter2`, `--token="a b"`.
  [
    new RegExp(
      `(?<!\\S)(--?${SECRET_KEY_NAMES}[ \\t=]+)(["'])(?:\\\\.|(?!\\2)[^\\\\\\n])+(\\2|$)`,
      'gim'
    ),
    '$1$2[REDACTED]$3',
  ],
  [new RegExp(`(?<!\\S)(--?${SECRET_KEY_NAMES}[ \\t=]+)(?![-"'])[^\\s"']+`, 'gi'), '$1[REDACTED]'],
  // A bearer credential with no key in front of it, as a curl header shows one.
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  // The password in a URL: `scheme://user:password@host`.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi, '$1[REDACTED]@'],
  // PEM blocks (private keys)
  [/-----BEGIN[^-\n]{1,40}-----[\s\S]+?-----END[^-\n]{1,40}-----/g, '[REDACTED_PEM_BLOCK]'],
  // Known token prefixes — order matters: vendor-specific before generic
  [/\bgh[opsu]_[A-Za-z0-9]{36,255}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GITLAB_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{36,}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_OPENAI_KEY]'],
  // `xoxe` is a rotating/refresh token; `xapp` is an app-level token, which a
  // Slack bridge needs alongside the bot token for Socket Mode.
  [/\b(?:xox[abepprs]|xapp)-[A-Za-z0-9-]{15,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Discord bot token: base64 client id . 6-char timestamp . hmac. Unprefixed,
  // so it is matched structurally. Kept after the JWT rule, whose middle
  // segment is far longer than six characters, so the two cannot collide.
  [/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, '[REDACTED_DISCORD_TOKEN]'],
  // Telegram bot token: numeric bot id : 35-char hmac. Also unprefixed, so it
  // is matched structurally. The colon keeps it clear of the Discord rule.
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]'],
];

/** `value` with each of `patterns` replaced, in order. */
export function applyRedactions(
  value: string,
  patterns: Array<[RegExp, RedactionReplacement]>
): string {
  return patterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement as string),
    value
  );
}

/** `value` with everything shaped like a secret replaced. */
export function redactSecrets(value: string): string {
  return applyRedactions(value, SECRET_PATTERNS);
}
