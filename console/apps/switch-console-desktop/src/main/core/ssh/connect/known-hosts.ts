// OpenSSH known_hosts handling for the ssh2 host-key check.
//
// ssh2 accepts any host key when no `hostVerifier` is given, so without this the
// Console would complete a connection to whatever answers on the address and hand
// it the user's credentials or forwarded agent. This reads the same known_hosts
// files OpenSSH would use for the host (resolved from `ssh -G`), pins the key on
// first use, and refuses to connect when a pinned key changes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type KnownHostsMarker = 'cert-authority' | 'revoked';

export interface KnownHostsEntry {
  marker?: KnownHostsMarker;
  /** Raw host patterns, still comma-separated as written in the file. */
  patterns: string[];
  keyType: string;
  /** base64 key blob exactly as stored. */
  key: string;
}

export type HostKeyVerdict =
  /** A stored key for this host matches the one offered. */
  | { kind: 'match' }
  /** A key is stored for this host and it is NOT the one offered. */
  | { kind: 'mismatch' }
  /** The offered key is explicitly revoked. */
  | { kind: 'revoked' }
  /** Nothing is stored for this host. */
  | { kind: 'unknown' };

/**
 * Parse one known_hosts line. Returns undefined for blanks, comments, and lines
 * we cannot make sense of, which is what OpenSSH does: an unreadable line is
 * skipped rather than treated as an error.
 */
export function parseKnownHostsLine(line: string): KnownHostsEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;

  let fields = trimmed.split(/\s+/);
  let marker: KnownHostsMarker | undefined;
  if (fields[0] === '@cert-authority' || fields[0] === '@revoked') {
    marker = fields[0].slice(1) as KnownHostsMarker;
    fields = fields.slice(1);
  }

  const [hosts, keyType, key] = fields;
  if (!hosts || !keyType || !key) return undefined;

  return { marker, patterns: hosts.split(','), keyType, key };
}

function hashedPatternMatches(pattern: string, host: string): boolean {
  // |1|<base64 salt>|<base64 HMAC-SHA1 of the host under that salt>
  const parts = pattern.split('|');
  if (parts.length !== 4 || parts[1] !== '1') return false;
  const [, , salt, digest] = parts;
  try {
    const expected = createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64');
    return expected === digest;
  } catch {
    return false;
  }
}

function globPatternMatches(pattern: string, host: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === host;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(host);
}

/**
 * The names OpenSSH looks a host up under. A non-default port is only ever
 * stored in the bracketed form, so both are checked and `[host]:22` is not.
 */
export function hostLookupKeys(host: string, port: number): string[] {
  return port === 22 ? [host] : [`[${host}]:${port}`];
}

function entryMatchesHost(entry: KnownHostsEntry, lookupKeys: string[]): boolean {
  let matched = false;
  for (const pattern of entry.patterns) {
    // A leading `!` excludes the host outright, even if a later pattern matches.
    const negated = pattern.startsWith('!');
    const bare = negated ? pattern.slice(1) : pattern;
    const hit = bare.startsWith('|')
      ? lookupKeys.some((name) => hashedPatternMatches(bare, name))
      : lookupKeys.some((name) => globPatternMatches(bare, name));
    if (!hit) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function sameKey(storedBase64: string, offered: Buffer): boolean {
  let stored: Buffer;
  try {
    stored = Buffer.from(storedBase64, 'base64');
  } catch {
    return false;
  }
  if (stored.length !== offered.length) return false;
  return timingSafeEqual(stored, offered);
}

/**
 * Decide what the known_hosts entries say about the key a server just offered.
 *
 * A `@cert-authority` line is reported as `unknown` rather than `match`: this
 * does not validate host certificates, and treating a CA line as proof would
 * accept any key for that host. Reporting it unknown means the host still gets
 * pinned on first use and a later change is still caught.
 */
export function checkHostKey(
  entries: KnownHostsEntry[],
  host: string,
  port: number,
  offeredKey: Buffer
): HostKeyVerdict {
  const lookupKeys = hostLookupKeys(host, port);
  let sawHost = false;

  for (const entry of entries) {
    if (!entryMatchesHost(entry, lookupKeys)) continue;
    if (entry.marker === 'cert-authority') continue;

    const keyMatches = sameKey(entry.key, offeredKey);
    if (entry.marker === 'revoked') {
      if (keyMatches) return { kind: 'revoked' };
      continue;
    }
    if (keyMatches) return { kind: 'match' };
    sawHost = true;
  }

  return sawHost ? { kind: 'mismatch' } : { kind: 'unknown' };
}

export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/**
 * Split the space-separated file list `ssh -G` prints, honouring the double
 * quotes OpenSSH uses around paths that contain spaces.
 */
export function splitKnownHostsFiles(value: string | undefined): string[] {
  if (!value) return [];
  const paths: string[] = [];
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/g)) {
    const path = match[1] ?? match[2];
    if (path && path.toLowerCase() !== 'none') paths.push(path);
  }
  return paths;
}

export interface KnownHostsDeps {
  readFile: (path: string) => Promise<string>;
  appendFile: (path: string, contents: string) => Promise<void>;
  home: string;
}

export function defaultKnownHostsDeps(): KnownHostsDeps {
  return {
    readFile: async (path) => await readFile(path, 'utf8'),
    // 0o600: the file records which hosts this user connects to.
    appendFile: async (path, contents) => await appendFile(path, contents, { mode: 0o600 }),
    home: homedir(),
  };
}

/** Read and parse every readable known_hosts file. Missing files are not an error. */
export async function readKnownHosts(
  files: string[],
  deps: KnownHostsDeps
): Promise<KnownHostsEntry[]> {
  const entries: KnownHostsEntry[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = await deps.readFile(expandHomePath(file, deps.home));
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const entry = parseKnownHostsLine(line);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/**
 * Read the algorithm name out of an SSH public key blob, which starts with a
 * 4-byte big-endian length followed by that many bytes of name.
 */
export function readKeyType(key: Buffer): string | undefined {
  if (key.length < 4) return undefined;
  const length = key.readUInt32BE(0);
  if (length === 0 || length > 64 || key.length < 4 + length) return undefined;
  const name = key.subarray(4, 4 + length).toString('ascii');
  return /^[\x21-\x7e]+$/.test(name) ? name : undefined;
}

export function formatKnownHostsLine(
  host: string,
  port: number,
  keyType: string,
  key: Buffer,
  options: { hash?: boolean; salt?: Buffer } = {}
): string {
  const [name] = hostLookupKeys(host, port);
  if (!options.hash) return `${name} ${keyType} ${key.toString('base64')}\n`;
  // Same 20-byte SHA1-sized salt OpenSSH uses for hashed entries.
  const salt = options.salt ?? randomBytes(20);
  const digest = createHmac('sha1', salt).update(name).digest('base64');
  return `|1|${salt.toString('base64')}|${digest} ${keyType} ${key.toString('base64')}\n`;
}

/** Append a first-use entry. A failure here must not fail the connection. */
export async function rememberHostKey(
  file: string,
  line: string,
  deps: KnownHostsDeps
): Promise<boolean> {
  const path = expandHomePath(file, deps.home);
  if (!isAbsolute(path)) return false;
  try {
    // A hand-edited known_hosts often has no trailing newline. Appending
    // straight onto it would weld the new entry to the last one and lose both,
    // so start a line first when the file does not already end in one.
    let separator = '';
    try {
      const existing = await deps.readFile(path);
      if (existing !== '' && !existing.endsWith('\n')) separator = '\n';
    } catch {
      // No file yet, so there is nothing to run into.
    }
    await deps.appendFile(path, `${separator}${line}`);
    return true;
  } catch {
    return false;
  }
}
