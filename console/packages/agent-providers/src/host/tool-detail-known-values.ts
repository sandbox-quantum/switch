/**
 * The env/MCP source of known values for a tool call's detail.
 *
 * What it adds: the secrets the host itself hands the agent and its MCP
 * servers — the agent's secret environment entries, the password of any URL
 * with userinfo in it, an HTTP MCP server's `Authorization` and other secret
 * headers and the userinfo of its URL, and a stdio MCP server's secret
 * environment. These are often tokens with no prefix a pattern would know (a
 * Codex MCP bearer token is passed in the environment,
 * `codex/config-args.ts`), so only their exact values find them.
 *
 * It is an addition beyond the session's own redaction list. Removing it is
 * one call site: `hostKnownValues` in `toolDetailRegistry` (shared-host.ts).
 */

import type { McpServerSpec, ProviderSessionStartInput } from '../adapter';

/** Words that make an environment variable secret wherever they are in its name. */
const SECRET_WORDS = [
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'SECRET',
  'TOKEN',
  'APIKEY',
  'CREDENTIAL',
  'PRIVATE',
];

/** Name segments, split on `_` and `-`, that make an environment variable secret. */
const SECRET_SEGMENTS = new Set(['KEY', 'AUTH', 'PASS', 'PWD', 'DSN', 'CRED', 'BEARER', 'COOKIE']);

/**
 * The shortest value taken as a secret on the strength of its name alone (a
 * secret-named environment entry or MCP header): 8, because such a name does
 * not make a short value a credential (`AUTH_MODE=public`), and a short value
 * would mask ordinary words wherever they appear. This minimum and the next
 * count every value and every part taken from one (a decoded `Basic`
 * password, a URL's userinfo) without the white space around it, as the
 * registry also searches for it trimmed (`'   abc  '` would otherwise
 * register `abc`).
 */
const SECRET_MIN = 8;

/**
 * The shortest credential taken from an authentication source (the credential
 * after an `Authorization` scheme, a decoded `Basic` password and
 * `user:password`, the password of a URL with userinfo): 6, because there the
 * source itself says the value is a credential, so a short one is still one.
 */
const AUTH_CREDENTIAL_MIN = 6;

/**
 * Names with a secret word or segment whose values are not secrets: `PWD` and
 * `OLDPWD` are the shell's working directories, the value of
 * `GOOGLE_APPLICATION_CREDENTIALS` is the path to a credentials file, not the
 * credentials, and `SSH_AUTH_SOCK` is the path to the SSH agent's socket.
 */
const NOT_SECRET_NAMES = new Set([
  'PWD',
  'OLDPWD',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SSH_AUTH_SOCK',
]);

/**
 * Whether an environment variable's name names a secret: a long word
 * anywhere in it, or a short one as a whole segment. The names in
 * `NOT_SECRET_NAMES` themselves are not; `MYSQL_PWD` is still a secret.
 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (NOT_SECRET_NAMES.has(upper)) return false;
  if (SECRET_WORDS.some((word) => upper.includes(word))) return true;
  return upper.split(/[_-]/).some((segment) => SECRET_SEGMENTS.has(segment));
}

/** The user name and password of a URL with userinfo, as written in it; `null` otherwise. */
function urlUserinfo(value: string): { username: string; password: string } | null {
  try {
    const url = new URL(value);
    if (url.username === '' && url.password === '') return null;
    return { username: url.username, password: url.password };
  } catch {
    return null;
  }
}

/**
 * The password and `user:password` of a URL's userinfo as written in it, and,
 * when they hold percent escapes, as they read decoded. A malformed escape
 * leaves the decoded form out.
 */
function userinfoValues(userinfo: { username: string; password: string }): string[] {
  const written = [userinfo.password, `${userinfo.username}:${userinfo.password}`];
  const values = [...written];
  for (const form of written) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      continue;
    }
    if (decoded !== form) values.push(decoded);
  }
  return values;
}

/**
 * The password and `user:password` of a value that is a URL with a non-empty
 * password, as written and decoded, each at least `AUTH_CREDENTIAL_MIN` long;
 * nothing for any other value, including one that does not parse as a URL.
 */
function urlKnownValues(value: string): string[] {
  const userinfo = urlUserinfo(value);
  if (!userinfo || userinfo.password === '') return [];
  return userinfoValues(userinfo).filter((part) => part.trim().length >= AUTH_CREDENTIAL_MIN);
}

/**
 * The secret entries of an environment, and the password and the whole
 * userinfo of every value that is a URL with userinfo, whatever the
 * variable's name, as written and decoded.
 */
export function envKnownValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const known: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (value.trim().length >= SECRET_MIN && isSecretEnvName(name)) known.push(value);
    known.push(...urlKnownValues(value));
  }
  return known;
}

/** A `Basic` credential: base64 without whitespace. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const unpadded = (encoded: string) => encoded.replace(/=+$/, '');

/**
 * The parts of an `Authorization` value: the whole value; with a scheme word,
 * the credential after it; and, for `Basic`, the `user:password` it decodes
 * to and the password.
 */
function authorizationValues(value: string): string[] {
  const parts = /^([A-Za-z][\w.+-]*)[ \t]+(\S.*)$/.exec(value);
  if (!parts) return [value];
  const scheme = parts[1]!;
  const credential = parts[2]!;
  const values = [value, credential];
  if (scheme.toLowerCase() !== 'basic' || !BASE64.test(credential)) return values;
  const decoded = Buffer.from(credential, 'base64').toString('utf8');
  // Only a credential that is valid base64 of UTF-8 text reads back the same.
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
  const exact = unpadded(reencoded) === unpadded(credential);
  const colon = decoded.indexOf(':');
  if (exact && colon >= 0) values.push(decoded, decoded.slice(colon + 1));
  return values;
}

/**
 * The secrets the session's MCP servers are given: the password and the whole
 * userinfo of an HTTP server's URL, as written and decoded (a tool output may
 * print the password alone, which the URL pattern does not mask); the values
 * of its `Authorization` header, whatever its scheme, and of every header
 * whose name names a secret (`X-Api-Key`, `Private-Token`); and the secret
 * entries of a stdio server's environment.
 */
export function mcpKnownValues(servers: Readonly<Record<string, McpServerSpec>>): string[] {
  const known: string[] = [];
  for (const spec of Object.values(servers)) {
    if (spec.transport === 'stdio') {
      if (spec.env) known.push(...envKnownValues(spec.env));
      continue;
    }
    known.push(...urlKnownValues(spec.url));
    for (const [header, value] of Object.entries(spec.headers ?? {})) {
      const authorization = header.toLowerCase() === 'authorization';
      if (!authorization && !isSecretEnvName(header)) continue;
      const values = authorization ? authorizationValues(value.trim()) : [value.trim()];
      const min = authorization ? AUTH_CREDENTIAL_MIN : SECRET_MIN;
      for (const part of values) if (part.trim().length >= min) known.push(part);
    }
  }
  return known;
}

/**
 * The env/MCP source: the secret values the host hands the agent in its
 * environment and its MCP servers in their headers and environment (see the
 * module comment for why, and how to drop it).
 */
export function hostKnownValues(
  input: Pick<ProviderSessionStartInput, 'env' | 'mcpServers'>
): string[] {
  return [...envKnownValues(input.env), ...mcpKnownValues(input.mcpServers)];
}
