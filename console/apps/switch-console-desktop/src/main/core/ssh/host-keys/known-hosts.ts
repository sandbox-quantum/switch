// OpenSSH known_hosts files: parsing, host matching and key lookup, following
// sshd(8) "SSH_KNOWN_HOSTS FILE FORMAT" and OpenSSH's own hostfile.c / match.c.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { HostKeyProblemKind, KnownHostKey } from '@shared/core/ssh/host-keys';

export type KnownHostsLine = {
  marker: 'revoked' | 'cert-authority' | null;
  hosts: { kind: 'hashed'; salt: Buffer; hash: Buffer } | { kind: 'patterns'; patterns: string[] };
  keyType: string;
  key: Buffer;
  /** `<path>:<line number>`, for telling the user where a key is recorded. */
  source: string;
};

/**
 * Host key algorithms ssh2 offers by default, in its own preference order.
 * Listed here rather than read from ssh2 because its constants are not public;
 * every entry is one ssh2 supports.
 */
const DEFAULT_SERVER_HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
] as const;

export type ServerHostKeyAlgorithm = (typeof DEFAULT_SERVER_HOST_KEY_ALGORITHMS)[number];

const HASHED_HOST_PREFIX = '|1|';

function readSshString(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length === 0 || blob.length < 4 + length) return null;
  return blob.subarray(4, 4 + length).toString('latin1');
}

/** The algorithm name a public key blob declares, e.g. `ssh-ed25519`. */
export function keyTypeOf(key: Buffer): string {
  const type = readSshString(key);
  if (!type) throw new Error('Malformed SSH public key: no key type');
  return type;
}

/** OpenSSH's SHA256 fingerprint: unpadded base64 of the blob's SHA-256. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The name a host's key is recorded under. `HostKeyAlias` replaces the host
 * name outright, port and all; otherwise a port other than 22 is written
 * `[host]:port`. OpenSSH compares host names in lower case.
 */
export function hostKeyName(
  hostname: string,
  port: number,
  hostKeyAlias: string | undefined
): string {
  if (hostKeyAlias) return hostKeyAlias.toLowerCase();
  const host = hostname.toLowerCase();
  return port === 22 || port === 0 ? host : `[${host}]:${port}`;
}

function parseHosts(field: string): KnownHostsLine['hosts'] | null {
  if (field.startsWith(HASHED_HOST_PREFIX)) {
    const [salt, hash] = field.slice(HASHED_HOST_PREFIX.length).split('|');
    if (!salt || !hash) return null;
    return { kind: 'hashed', salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
  }
  const patterns = field
    .split(',')
    .map((pattern) => pattern.toLowerCase())
    .filter(Boolean);
  return patterns.length > 0 ? { kind: 'patterns', patterns } : null;
}

/**
 * Parse a known_hosts file. Lines OpenSSH would skip as malformed — a legacy
 * RSA1 entry, an unknown `@` marker, a key whose blob does not match its
 * declared type — are skipped here too, as OpenSSH does.
 */
export function parseKnownHosts(text: string, path: string): KnownHostsLine[] {
  const lines: KnownHostsLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const fields = raw.trim().split(/\s+/);
    if (!fields[0] || fields[0].startsWith('#')) return;

    let marker: KnownHostsLine['marker'] = null;
    if (fields[0].startsWith('@')) {
      if (fields[0] === '@revoked') marker = 'revoked';
      else if (fields[0] === '@cert-authority') marker = 'cert-authority';
      else return;
      fields.shift();
    }

    const [hostField, keyType, keyData] = fields;
    if (!hostField || !keyType || !keyData) return;
    const hosts = parseHosts(hostField);
    if (!hosts) return;

    const key = Buffer.from(keyData, 'base64');
    if (readSshString(key) !== keyType) return;

    lines.push({ marker, hosts, keyType, key, source: `${path}:${index + 1}` });
  });
  return lines;
}

/** OpenSSH `match_pattern`: `*` is any run of characters, `?` exactly one. */
function matchPattern(name: string, pattern: string): boolean {
  let n = 0;
  let p = 0;
  let starP = -1;
  let starN = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      n++;
      p++;
    } else if (p < pattern.length && pattern[p] === '*') {
      starP = p++;
      starN = n;
    } else if (starP !== -1) {
      p = starP + 1;
      n = ++starN;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Whether a line names this host. A hashed entry is HMAC-SHA1 of the name
 * keyed by its salt. A pattern list matches when some pattern does and no
 * negated (`!`) pattern does.
 */
export function lineMatchesHost(line: KnownHostsLine, name: string): boolean {
  if (line.hosts.kind === 'hashed') {
    const digest = createHmac('sha1', line.hosts.salt).update(name).digest();
    return digest.length === line.hosts.hash.length && timingSafeEqual(digest, line.hosts.hash);
  }
  let positive = false;
  for (const pattern of line.hosts.patterns) {
    if (pattern.startsWith('!')) {
      if (matchPattern(name, pattern.slice(1))) return false;
    } else if (matchPattern(name, pattern)) {
      positive = true;
    }
  }
  return positive;
}

export type HostKeyLookup =
  | { status: 'match' }
  | { status: Exclude<HostKeyProblemKind, 'unknown'>; known: KnownHostKey[] }
  | { status: 'unknown' };

function describe(line: KnownHostsLine): KnownHostKey {
  return { keyType: line.keyType, fingerprint: fingerprintOf(line.key), source: line.source };
}

/**
 * Check a presented key against every line recorded for the host.
 *
 * A key marked `@revoked` is refused outright. Otherwise any matching entry
 * accepts it, as in OpenSSH. Any other key on record for the host — of any
 * type — makes it a changed key: the connection prefers algorithms already on
 * record (`preferredServerHostKeyAlgorithms`), so a genuine host presents one
 * of those, and treating a new type as merely unknown would let an impostor
 * that offers only a type not on record pass as a first contact.
 * `@cert-authority` lines are not used: ssh2 does not negotiate host
 * certificates.
 */
export function lookupHostKey(lines: KnownHostsLine[], name: string, key: Buffer): HostKeyLookup {
  const forHost = lines.filter((line) => lineMatchesHost(line, name));
  const revoked = forHost.filter((line) => line.marker === 'revoked' && line.key.equals(key));
  if (revoked.length > 0) return { status: 'revoked', known: revoked.map(describe) };

  const recorded = forHost.filter((line) => line.marker === null);
  if (recorded.some((line) => line.key.equals(key))) return { status: 'match' };
  if (recorded.length > 0) return { status: 'changed', known: recorded.map(describe) };
  return { status: 'unknown' };
}

const ALGORITHMS_FOR_KEY_TYPE: Record<string, ServerHostKeyAlgorithm[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

/**
 * ssh2's host key algorithms, reordered so the types already on record for
 * the host come first — what OpenSSH does — so a host with several keys
 * presents the one Console can check rather than one it has never seen.
 */
export function preferredServerHostKeyAlgorithms(
  lines: KnownHostsLine[],
  name: string
): ServerHostKeyAlgorithm[] {
  const known = new Set<ServerHostKeyAlgorithm>();
  for (const line of lines) {
    if (line.marker !== null || !lineMatchesHost(line, name)) continue;
    for (const algorithm of ALGORITHMS_FOR_KEY_TYPE[line.keyType] ?? []) known.add(algorithm);
  }
  return [
    ...DEFAULT_SERVER_HOST_KEY_ALGORITHMS.filter((algorithm) => known.has(algorithm)),
    ...DEFAULT_SERVER_HOST_KEY_ALGORITHMS.filter((algorithm) => !known.has(algorithm)),
  ];
}

/** One known_hosts line recording `key` under `name`. */
export function formatKnownHostsLine(name: string, key: Buffer): string {
  return `${name} ${keyTypeOf(key)} ${key.toString('base64')}`;
}
