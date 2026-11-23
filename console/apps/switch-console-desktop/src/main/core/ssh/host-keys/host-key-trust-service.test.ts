import { describe, expect, it } from 'vitest';
import type { HostKeyProblem } from '@shared/core/ssh/host-keys';
import { HostKeyTrustService } from './host-key-trust-service';

const key = Buffer.from('presented-key');

function problem(overrides: Partial<HostKeyProblem> = {}): HostKeyProblem {
  return {
    sshHost: 'build',
    hostKeyName: '[example.test]:2222',
    kind: 'unknown',
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:one',
    known: [],
    trustRefusal: null,
    ...overrides,
  };
}

function makeService() {
  const trusted: Array<{ name: string; key: Buffer }> = [];
  const published: HostKeyProblem[][] = [];
  const service = new HostKeyTrustService({
    trust: async (name, value) => {
      trusted.push({ name, key: value });
    },
    publish: (problems) => published.push(problems),
    log: { info: () => {}, warn: () => {} },
  });
  return { service, trusted, published };
}

describe('HostKeyTrustService', () => {
  it('asks once per presented key, however many connections hit it', () => {
    const { service, published } = makeService();
    service.report(problem(), key);
    service.report(problem(), key);
    expect(published).toEqual([[problem()]]);
    expect(service.list()).toEqual([problem()]);
  });

  it('records exactly the key the host presented, under the name it was checked as', async () => {
    const { service, trusted } = makeService();
    service.report(problem(), key);
    const decision = service.waitForDecision('build');

    await service.trust('build', 'SHA256:one');

    expect(trusted).toEqual([{ name: '[example.test]:2222', key }]);
    await expect(decision).resolves.toBe('trusted');
    expect(service.list()).toEqual([]);
  });

  it('trusts nothing when the fingerprint is not the one waiting', async () => {
    const { service, trusted } = makeService();
    service.report(problem(), key);
    service.report(problem({ fingerprint: 'SHA256:two' }), Buffer.from('other'));

    await expect(service.trust('build', 'SHA256:one')).rejects.toThrow(/No SSH host key/);
    expect(trusted).toEqual([]);
  });

  it('refuses to trust a key that cannot be trusted from Switch Console', async () => {
    const { service, trusted } = makeService();
    service.report(problem({ kind: 'revoked', trustRefusal: 'revoked' }), key);

    expect(service.waitForDecision('build')).toBeUndefined();
    await expect(service.trust('build', 'SHA256:one')).rejects.toThrow('revoked');
    expect(trusted).toEqual([]);
  });

  it('stops asking about a key the user turned down until they retry', async () => {
    const { service } = makeService();
    service.report(problem(), key);
    const decision = service.waitForDecision('build');

    service.dismiss('build', 'SHA256:one');
    await expect(decision).resolves.toBe('dismissed');

    service.report(problem(), key);
    expect(service.list()).toEqual([]);

    service.clearDismissals('build');
    service.report(problem(), key);
    expect(service.list()).toEqual([problem()]);
  });

  it('settles a waiting key once the host checks out by other means', async () => {
    const { service } = makeService();
    service.report(problem(), key);
    const decision = service.waitForDecision('build');

    service.reportVerified('build');

    await expect(decision).resolves.toBe('trusted');
    expect(service.list()).toEqual([]);
  });
});
