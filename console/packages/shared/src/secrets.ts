type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

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

const SECRET_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
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
 * Credentials in the forms logs, configs and HTTP traces write them, and the
 * prefixes of well-known vendors' keys. Personal data is left alone.
 */
export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement as string),
    value
  );
}
