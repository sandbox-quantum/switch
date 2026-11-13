import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchSignature,
  NO_TRUSTED_KEYS,
  signatureUrl,
  signedMessage,
  verifyDownloadedRelease,
  verifyReleaseSignature,
} from './release-signing';
import { signRelease, testSigningKey } from './testing/release-signing';

const SHA = createHash('sha256').update('a package').digest('hex');
const current = testSigningKey('release-current');
const next = testSigningKey('release-next');
const stranger = testSigningKey('someone-else');

describe('signedMessage', () => {
  it('names the scheme, the version and the SHA-256 in lower case, one per line', () => {
    expect(signedMessage('0.31.0', SHA.toUpperCase())).toBe(
      `switch-agent-controller-release-v1\n0.31.0\n${SHA}\n`
    );
  });
});

describe('signatureUrl', () => {
  it('is the package path with .sig, the query kept', () => {
    expect(signatureUrl('https://example.invalid/r/switch-agent-controller-0.31.0.tgz')).toBe(
      'https://example.invalid/r/switch-agent-controller-0.31.0.tgz.sig'
    );
    expect(signatureUrl('https://example.invalid/p.tgz?token=x')).toBe(
      'https://example.invalid/p.tgz.sig?token=x'
    );
  });
});

describe('verifyReleaseSignature', () => {
  const verifying = (signature: string, keys = [current.trusted], version = '0.31.0') =>
    verifyReleaseSignature({ version, sha256: SHA, signature, keys });

  it('names the trusted key that verifies a signature', () => {
    expect(verifying(signRelease(current, '0.31.0', SHA))).toBe('release-current');
  });

  it('accepts any trusted key, so keys can be rotated', () => {
    const both = [current.trusted, next.trusted];
    expect(verifying(signRelease(next, '0.31.0', SHA), both)).toBe('release-next');
    expect(verifying(signRelease(current, '0.31.0', SHA), both)).toBe('release-current');
  });

  it('refuses a signature by a key it does not trust', () => {
    expect(() => verifying(signRelease(stranger, '0.31.0', SHA))).toThrow(
      /does not verify switch-agent-controller 0.31.0 .* \(release-current\)/
    );
  });

  it('refuses a signature made for another SHA-256 or another version', () => {
    expect(() => verifying(signRelease(current, '0.31.0', 'b'.repeat(64)))).toThrow(
      /does not verify/
    );
    expect(() => verifying(signRelease(current, '0.30.0', SHA))).toThrow(/does not verify/);
    expect(() =>
      verifying(signRelease(current, '0.31.0', SHA), [current.trusted], '0.32.0')
    ).toThrow(/does not verify/);
  });

  it('refuses what is not a signature', () => {
    for (const signature of ['', 'not base64!', Buffer.alloc(63).toString('base64')])
      expect(() => verifying(signature)).toThrow(/not a base64 Ed25519 signature/);
  });

  it('refuses everything with no trusted key', () => {
    expect(() => verifying(signRelease(current, '0.31.0', SHA), [])).toThrow(NO_TRUSTED_KEYS);
  });

  it('refuses a trusted key that is not Ed25519', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ec = {
      id: 'ec',
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    expect(() => verifying(signRelease(current, '0.31.0', SHA), [ec])).toThrow(/not an Ed25519/);
  });
});

describe('fetching and verifying a downloaded release', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-signing-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const url = 'https://example.invalid/switch-agent-controller-0.31.0.tgz';
  const answering = (status: number, body: string) =>
    (async (requested: string | URL | Request) => {
      expect(String(requested)).toBe(`${url}.sig`);
      return new Response(body, { status });
    }) as typeof fetch;

  it('fails loud when the release has no signature', async () => {
    await expect(fetchSignature(answering(404, 'no'), url, null)).rejects.toThrow(
      /has no signature: fetching .*\.sig answered 404/
    );
  });

  it('keeps a package whose signature verifies, and deletes one whose does not', async () => {
    const file = join(dir, 'package.tgz');
    writeFileSync(file, 'a package');
    const common = { file, url, version: '0.31.0', sha256: SHA, signal: null };
    expect(
      await verifyDownloadedRelease({
        ...common,
        fetch: answering(200, signRelease(current, '0.31.0', SHA)),
        keys: [current.trusted],
      })
    ).toBe('release-current');
    expect(readdirSync(dir)).toEqual(['package.tgz']);
    await expect(
      verifyDownloadedRelease({
        ...common,
        fetch: answering(200, signRelease(stranger, '0.31.0', SHA)),
        keys: [current.trusted],
      })
    ).rejects.toThrow(/does not verify.*was deleted/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
