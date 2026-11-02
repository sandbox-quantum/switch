/**
 * Pattern redaction of secrets: what a credential looks like, as opposed to
 * the exact values a session host holds (`host/redaction.ts`). The desktop
 * log runs every entry through `redactSecrets` on its way to disk, and a
 * session host runs a tool call's detail through it before the detail leaves
 * the machine. One set, so the two cannot drift apart.
 */

/** The words that mark a value as a credential. */
const SECRET_KEY_WORDS =
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
const SECRET_KEY_NAMES = `(?:[a-z0-9]+[_-])*(?:${SECRET_KEY_WORDS})`;

const SECRET_NAME = new RegExp(`^${SECRET_KEY_NAMES}s?$`, 'i');

/**
 * Whether `name`, an environment variable or a header, holds a credential by
 * the same words the patterns below key on: `GITHUB_TOKEN`, `db-password`,
 * `Authorization`.
 */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

export type RedactionPattern = readonly [RegExp, RedactionReplacement];

const SECRET_PATTERNS: readonly RedactionPattern[] = [
  // JSON-quoted key/value: handles both "key":"value" and escaped \"key\":\"value\"
  [
    new RegExp(`(\\\\?")(${SECRET_KEY_NAMES})(\\\\?")(\\s*:\\s*)\\\\?"[^"\\\\]*\\\\?"`, 'gi'),
    (_match, openQuote: string, keyName: string, closeQuote: string, separator: string) =>
      `${openQuote}${keyName}${closeQuote}${separator}${openQuote}[REDACTED]${openQuote}`,
  ],
  // Unquoted: key=value, or key: <scheme> value. The scheme alternation must
  // stay in step with the auth schemes we might log: without `bot`, Discord's
  // `Authorization: Bot <token>` redacts the word "Bot" and leaves the token.
  [
    new RegExp(
      `\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(?:(?:bearer|bot|token)\\s+)?[^\\s,"'}]+`,
      'gi'
    ),
    '$1$2[REDACTED]',
  ],
  // PEM blocks (private keys)
  [/-----BEGIN[^-\n]{1,40}-----[\s\S]+?-----END[^-\n]{1,40}-----/g, '[REDACTED_PEM_BLOCK]'],
  // Known token prefixes — order matters: vendor-specific before generic
  [/\bgh[opsu]_[A-Za-z0-9]{36,255}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GITLAB_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{36,}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
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

/**
 * Any `scheme://user:password@` — postgres, mongodb, redis, mysql, amqp,
 * https. Not one of the write-path patterns: the desktop log keeps the
 * connection strings it records, the way it keeps every other piece of
 * personal data, and removes them only when content leaves the machine.
 */
export const URL_CREDENTIALS: RedactionPattern = [
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/?#@]+:[^\s@/?#]+@/gi,
  '$1[REDACTED_CREDENTIALS]@',
];

export function applyRedactions(value: string, patterns: readonly RedactionPattern[]): string {
  return patterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement as string),
    value
  );
}

/** Tokens, keys, JWTs, PEM blocks and credential-named values, by pattern. */
export function redactSecrets(value: string): string {
  return applyRedactions(value, SECRET_PATTERNS);
}

/** `redactSecrets`, and the password in a URL as well. */
export function redactSecretsAndUrlCredentials(value: string): string {
  return applyRedactions(redactSecrets(value), [URL_CREDENTIALS]);
}
