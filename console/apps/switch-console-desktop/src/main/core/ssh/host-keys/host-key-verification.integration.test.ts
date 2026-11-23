import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedSshConfig } from '../config/resolve-ssh-config';
import { resolveSshConnectConfig } from '../connect/resolve-ssh-connect-config';
import { SshConnectionManager } from '../lifecycle/ssh-connection-manager';
import { ConsoleKnownHosts } from './console-known-hosts';
import { prepareHostKeyCheck, SshHostKeyError, type HostKeyTarget } from './host-key-check';
import { HostKeyTrustService } from './host-key-trust-service';
import { fingerprintOf } from './known-hosts';

/**
 * Host key verification end to end: a real ssh2 server, the real resolver,
 * verifier, trust service, Console known_hosts file and connection manager.
 * Only `ssh -G` is stood in for. Every connection names the host by
 * `HostKeyAlias`, so two servers on two ports can play one host whose key
 * changed (a reinstall, or someone in the middle).
 */

const { Server, utils } = ssh2;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

type FakeHost = {
  server: ssh2.Server;
  port: number;
  publicKey: string;
  fingerprint: string;
  connections: ssh2.Connection[];
};

async function startHost(): Promise<FakeHost> {
  // ECDSA rather than ed25519: ssh2's ed25519 generator occasionally emits a
  // malformed public key.
  const keys = utils.generateKeyPairSync('ecdsa', { bits: 256 });
  const parsed = utils.parseKey(keys.public);
  if (parsed instanceof Error) throw parsed;
  const connections: ssh2.Connection[] = [];
  const server = new Server({ hostKeys: [keys.private] }, (connection) => {
    connections.push(connection);
    connection.on('error', () => {});
    connection.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept();
      else ctx.reject(['password']);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    server,
    port,
    publicKey: keys.public,
    fingerprint: fingerprintOf(parsed.getPublicSSH()),
    connections,
  };
}

let dir: string;
let hosts: FakeHost[];
let manager: SshConnectionManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'switch-console-host-keys-'));
  hosts = [];
});

afterEach(async () => {
  await manager?.disconnectAll();
  for (const host of hosts) host.server.close();
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const userKnownHosts = join(dir, 'known_hosts');
  const consoleKnownHosts = new ConsoleKnownHosts(() => join(dir, 'console', 'known_hosts'), {
    readFile: (path) => readFile(path, 'utf-8'),
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
  });
  const trust = new HostKeyTrustService({
    trust: (name, key) => consoleKnownHosts.trust(name, key),
    publish: () => {},
    log: quiet,
  });
  const checkHostKey = (target: HostKeyTarget) =>
    prepareHostKeyCheck(target, {
      readKnownHostsFile: async (path) => {
        try {
          return await readFile(path, 'utf-8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      },
      consoleKnownHosts,
      reportProblem: (problem, key) => trust.report(problem, key),
      reportVerified: (sshHost) => trust.reportVerified(sshHost),
    });

  const route = { port: 0 };
  manager = new SshConnectionManager({ log: quiet });
  manager.register('build', () =>
    resolveSshConnectConfig(
      {
        kind: 'transient',
        config: {
          name: 'build',
          host: 'build',
          port: 22,
          username: '',
          sshConfigAlias: 'build',
          authType: 'password',
          password: 'secret',
        },
      },
      checkHostKey,
      {
        resolveSshConfig: async (): Promise<ResolvedSshConfig> => ({
          hostname: '127.0.0.1',
          user: 'alice',
          port: route.port,
          identityFile: [],
          identityAgentDisabled: false,
          identitiesOnly: false,
          forwardAgent: false,
          connectTimeout: 5,
          hostKeyAlias: 'build-box',
          userKnownHostsFiles: [userKnownHosts],
          globalKnownHostsFiles: [],
          strictHostKeyChecking: 'ask',
        }),
      }
    )
  );
  return { userKnownHosts, trust, route };
}

async function refusal(promise: Promise<unknown>): Promise<SshHostKeyError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the connection to be refused');
    },
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(SshHostKeyError);
  return error as SshHostKeyError;
}

describe('SSH host key verification', () => {
  it('refuses an unknown host until the user trusts the key it presented', async () => {
    const { trust, route } = setup();
    const host = await startHost();
    hosts.push(host);
    route.port = host.port;

    const error = await refusal(manager.connect('build'));
    expect(error.problem).toMatchObject({
      kind: 'unknown',
      hostKeyName: 'build-box',
      fingerprint: host.fingerprint,
    });
    expect(trust.list()).toHaveLength(1);
    expect(host.connections.some((c) => c.authenticated)).toBe(false);

    await trust.trust('build', host.fingerprint);
    const proxy = await manager.connect('build');
    expect(proxy.isConnected).toBe(true);
  });

  it('connects to a host already in the user known_hosts without asking', async () => {
    const { userKnownHosts, trust, route } = setup();
    const host = await startHost();
    hosts.push(host);
    route.port = host.port;
    await writeFile(userKnownHosts, `build-box ${host.publicKey}\n`);

    const proxy = await manager.connect('build');
    expect(proxy.isConnected).toBe(true);
    expect(trust.list()).toEqual([]);
  });

  it('refuses a changed key, naming both fingerprints, and a background reconnect never accepts it', async () => {
    const { userKnownHosts, trust, route } = setup();
    const original = await startHost();
    const impostor = await startHost();
    hosts.push(original, impostor);
    await writeFile(userKnownHosts, `build-box ${original.publicKey}\n`);
    route.port = original.port;
    await manager.connect('build');

    // The host now answers with another key, and the live connection drops:
    // the manager reconnects on its own and must stop at the key.
    route.port = impostor.port;
    const stopped = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (trust.list().length > 0 && manager.getConnectionState('build') === 'error') {
          clearInterval(interval);
          resolve();
        }
      }, 25);
    });
    for (const connection of original.connections) connection.end();
    await stopped;

    const [problem] = trust.list();
    expect(problem).toMatchObject({
      kind: 'changed',
      fingerprint: impostor.fingerprint,
      known: [{ fingerprint: original.fingerprint, source: `${userKnownHosts}:1` }],
    });
    expect(impostor.connections.some((c) => c.authenticated)).toBe(false);

    const error = await refusal(manager.connect('build'));
    expect(error.message).toContain(original.fingerprint);
    expect(error.message).toContain(impostor.fingerprint);

    // Accepting the new key is an explicit act, and then it connects.
    await trust.trust('build', impostor.fingerprint);
    const proxy = await manager.connect('build');
    expect(proxy.isConnected).toBe(true);
  }, 15_000);
});
