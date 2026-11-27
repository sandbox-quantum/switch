import { describe, expect, it } from 'vitest';
import type { HostKeyProblem } from '@shared/core/ssh/host-keys';
import { prepareHostKeyCheck, SshHostKeyError, type HostKeyTarget } from './host-key-check';
import { parseKnownHosts, type KnownHostsLine } from './known-hosts';
import { ecdsaHostKey, ed25519HostKey, hashedHostName } from './test-host-keys';

const { key: ECDSA_KEY, fingerprint: ECDSA_FINGERPRINT } = ecdsaHostKey();
const { key: ED25519_KEY, fingerprint: ED25519_FINGERPRINT } = ed25519HostKey();
const HASHED_LINE = `${hashedHostName('[example.test]:2222')} ecdsa-sha2-nistp256 ${ECDSA_KEY}`;

const ecdsa = Buffer.from(ECDSA_KEY, 'base64');
const ed25519 = Buffer.from(ED25519_KEY, 'base64');

function target(overrides: Partial<HostKeyTarget> = {}): HostKeyTarget {
  return {
    sshHost: 'build',
    hostname: 'example.test',
    port: 2222,
    hostKeyAlias: undefined,
    userKnownHostsFiles: ['/home/u/.ssh/known_hosts'],
    globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts'],
    strictHostKeyChecking: 'ask',
    ...overrides,
  };
}

async function prepare(
  files: Record<string, string>,
  overrides: Partial<HostKeyTarget> = {},
  consoleLines: KnownHostsLine[] = []
) {
  const reported: HostKeyProblem[] = [];
  const verified: string[] = [];
  const check = await prepareHostKeyCheck(target(overrides), {
    readKnownHostsFile: async (path) => files[path] ?? null,
    consoleKnownHosts: { read: async () => consoleLines },
    reportProblem: (problem) => reported.push(problem),
    reportVerified: (sshHost) => verified.push(sshHost),
  });
  return { check, reported, verified };
}

describe('prepareHostKeyCheck', () => {
  it('refuses a host with no key on record and reports it for the user to decide', async () => {
    const { check, reported } = await prepare({});

    expect(check.hostVerifier(ecdsa)).toBe(false);
    expect(reported).toEqual([
      {
        sshHost: 'build',
        hostKeyName: '[example.test]:2222',
        kind: 'unknown',
        keyType: 'ecdsa-sha2-nistp256',
        fingerprint: ECDSA_FINGERPRINT,
        known: [],
        trustRefusal: null,
      },
    ]);
    const rejection = check.rejection();
    expect(rejection).toBeInstanceOf(SshHostKeyError);
    expect(rejection?.message).toContain(ECDSA_FINGERPRINT);
  });

  it('connects to a host whose key is in the user known_hosts, hashed or not', async () => {
    const plain = await prepare({
      '/home/u/.ssh/known_hosts': `[example.test]:2222 ecdsa-sha2-nistp256 ${ECDSA_KEY}`,
    });
    expect(plain.check.hostVerifier(ecdsa)).toBe(true);
    expect(plain.check.rejection()).toBeUndefined();
    expect(plain.reported).toEqual([]);
    expect(plain.verified).toEqual(['build']);

    const hashed = await prepare({ '/etc/ssh/ssh_known_hosts': HASHED_LINE });
    expect(hashed.check.hostVerifier(ecdsa)).toBe(true);
    expect(hashed.reported).toEqual([]);
  });

  it('connects to a host the user trusted from Switch Console', async () => {
    const { check } = await prepare(
      {},
      {},
      parseKnownHosts(`[example.test]:2222 ssh-ed25519 ${ED25519_KEY}`, '/data/ssh/known_hosts')
    );
    expect(check.hostVerifier(ed25519)).toBe(true);
  });

  it('refuses a changed key and names both fingerprints and where the old one is recorded', async () => {
    const { check, reported } = await prepare({
      '/home/u/.ssh/known_hosts': `[example.test]:2222 ecdsa-sha2-nistp256 ${ECDSA_KEY}`,
    });

    expect(check.hostVerifier(ed25519)).toBe(false);
    expect(reported[0]).toMatchObject({
      kind: 'changed',
      fingerprint: ED25519_FINGERPRINT,
      known: [
        {
          keyType: 'ecdsa-sha2-nistp256',
          fingerprint: ECDSA_FINGERPRINT,
          source: '/home/u/.ssh/known_hosts:1',
        },
      ],
      trustRefusal: null,
    });
    const message = check.rejection()?.message ?? '';
    expect(message).toContain('has changed');
    expect(message).toContain(ED25519_FINGERPRINT);
    expect(message).toContain(ECDSA_FINGERPRINT);
    expect(message).toContain("'build'");
  });

  it('looks a host up under its HostKeyAlias, without the port', async () => {
    const { check } = await prepare(
      { '/home/u/.ssh/known_hosts': `build-box ssh-ed25519 ${ED25519_KEY}` },
      { hostKeyAlias: 'build-box' }
    );
    expect(check.hostVerifier(ed25519)).toBe(true);
  });

  it('offers no trust for an unknown host when the SSH config says StrictHostKeyChecking yes', async () => {
    const { check, reported } = await prepare({}, { strictHostKeyChecking: 'yes' });
    expect(check.hostVerifier(ecdsa)).toBe(false);
    expect(reported[0]?.trustRefusal).toMatch(/StrictHostKeyChecking yes/);
  });

  it('never accepts a new key on its own, even under StrictHostKeyChecking no or accept-new', async () => {
    for (const strictHostKeyChecking of ['no', 'accept-new'] as const) {
      const { check, reported } = await prepare({}, { strictHostKeyChecking });
      expect(check.hostVerifier(ecdsa)).toBe(false);
      expect(reported[0]).toMatchObject({ kind: 'unknown', trustRefusal: null });
    }
  });

  it('refuses a revoked key with no way to trust it', async () => {
    const { check, reported } = await prepare({
      '/home/u/.ssh/known_hosts': [
        `[example.test]:2222 ecdsa-sha2-nistp256 ${ECDSA_KEY}`,
        `@revoked * ecdsa-sha2-nistp256 ${ECDSA_KEY}`,
      ].join('\n'),
    });
    expect(check.hostVerifier(ecdsa)).toBe(false);
    expect(reported[0]?.kind).toBe('revoked');
    expect(reported[0]?.trustRefusal).not.toBeNull();
  });

  it('puts the key types on record for the host first in the offered algorithms', async () => {
    const { check } = await prepare({
      '/home/u/.ssh/known_hosts': `[example.test]:2222 ecdsa-sha2-nistp256 ${ECDSA_KEY}`,
    });
    expect(check.serverHostKeyAlgorithms[0]).toBe('ecdsa-sha2-nistp256');
  });

  it('fails rather than guessing when a known_hosts file cannot be read', async () => {
    await expect(
      prepareHostKeyCheck(target(), {
        readKnownHostsFile: async () => {
          throw new Error('Could not read the known_hosts file /home/u/.ssh/known_hosts');
        },
        consoleKnownHosts: { read: async () => [] },
        reportProblem: () => {},
        reportVerified: () => {},
      })
    ).rejects.toThrow(/known_hosts/);
  });
});
