import { describe, expect, it } from 'vitest';
import type { KnownHostsDeps } from './known-hosts';
import {
  createHostVerifier,
  normalizeStrictHostKeyChecking,
  type HostKeyPolicy,
} from './ssh-connect-host-key';

function keyBlob(body: string): Buffer {
  const name = Buffer.from('ssh-ed25519', 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length, 0);
  return Buffer.concat([length, name, Buffer.from(body, 'utf8')]);
}

const HOST_KEY = keyBlob('the-real-key');
const OTHER_KEY = keyBlob('someone-elses-key');

const KNOWN_HOSTS = '/home/alice/.ssh/known_hosts';

function policy(overrides: Partial<HostKeyPolicy> = {}): HostKeyPolicy {
  return {
    host: 'host.example.com',
    port: 22,
    knownHostsFiles: [KNOWN_HOSTS],
    writeToFile: KNOWN_HOSTS,
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    ...overrides,
  };
}

function deps(contents: string | Error): { deps: Partial<KnownHostsDeps>; appended: string[] } {
  const appended: string[] = [];
  return {
    appended,
    deps: {
      readFile: async () => {
        if (contents instanceof Error) throw contents;
        return contents;
      },
      appendFile: async (_path, line) => {
        appended.push(line);
      },
      home: '/home/alice',
    },
  };
}

async function verify(
  hostKeyPolicy: HostKeyPolicy,
  knownHostsDeps: Partial<KnownHostsDeps>,
  key: Buffer
): Promise<boolean> {
  const verifier = createHostVerifier(hostKeyPolicy, knownHostsDeps);
  return await new Promise<boolean>((resolve) => {
    verifier(key, resolve);
  });
}

describe('normalizeStrictHostKeyChecking', () => {
  it('reads the values OpenSSH accepts and falls back to ask', () => {
    expect(normalizeStrictHostKeyChecking('yes')).toBe('yes');
    expect(normalizeStrictHostKeyChecking('  ACCEPT-NEW ')).toBe('accept-new');
    expect(normalizeStrictHostKeyChecking('off')).toBe('off');
    expect(normalizeStrictHostKeyChecking(undefined)).toBe('ask');
    expect(normalizeStrictHostKeyChecking('nonsense')).toBe('ask');
  });
});

describe('createHostVerifier', () => {
  const storedLine = (key: Buffer) => `host.example.com ssh-ed25519 ${key.toString('base64')}\n`;

  it('accepts the pinned key', async () => {
    const { deps: knownHosts, appended } = deps(storedLine(HOST_KEY));
    expect(await verify(policy(), knownHosts, HOST_KEY)).toBe(true);
    expect(appended).toEqual([]);
  });

  it('refuses a key that is not the pinned one', async () => {
    // The MITM case: the address answers, but with a key we never pinned.
    const { deps: knownHosts, appended } = deps(storedLine(OTHER_KEY));
    expect(await verify(policy(), knownHosts, HOST_KEY)).toBe(false);
    expect(appended).toEqual([]);
  });

  it('refuses a revoked key', async () => {
    const { deps: knownHosts } = deps(`@revoked ${storedLine(HOST_KEY)}`);
    expect(await verify(policy(), knownHosts, HOST_KEY)).toBe(false);
  });

  it('pins an unknown host on first use', async () => {
    const { deps: knownHosts, appended } = deps('');
    expect(await verify(policy(), knownHosts, HOST_KEY)).toBe(true);
    expect(appended).toEqual([storedLine(HOST_KEY)]);
  });

  it('pins an unknown host when known_hosts does not exist yet', async () => {
    const { deps: knownHosts, appended } = deps(new Error('ENOENT'));
    expect(await verify(policy(), knownHosts, HOST_KEY)).toBe(true);
    expect(appended).toEqual([storedLine(HOST_KEY)]);
  });

  it('refuses an unknown host under StrictHostKeyChecking=yes', async () => {
    const { deps: knownHosts, appended } = deps('');
    expect(await verify(policy({ strictHostKeyChecking: 'yes' }), knownHosts, HOST_KEY)).toBe(
      false
    );
    expect(appended).toEqual([]);
  });

  it('still refuses a changed key under StrictHostKeyChecking=no', async () => {
    // `no` only relaxes the unknown-host prompt. A key that changed under us is
    // refused whatever the setting says.
    const { deps: knownHosts } = deps(storedLine(OTHER_KEY));
    expect(await verify(policy({ strictHostKeyChecking: 'no' }), knownHosts, HOST_KEY)).toBe(false);
  });

  it('connects without recording when there is no file to write to', async () => {
    const { deps: knownHosts, appended } = deps('');
    expect(await verify(policy({ writeToFile: undefined }), knownHosts, HOST_KEY)).toBe(true);
    expect(appended).toEqual([]);
  });

  it('connects even when the key cannot be written', async () => {
    const { deps: knownHosts } = deps('');
    expect(
      await verify(
        policy(),
        {
          ...knownHosts,
          appendFile: async () => {
            throw new Error('EACCES');
          },
        },
        HOST_KEY
      )
    ).toBe(true);
  });

  it('writes a hashed entry when HashKnownHosts is on', async () => {
    const { deps: knownHosts, appended } = deps('');
    expect(await verify(policy({ hashKnownHosts: true }), knownHosts, HOST_KEY)).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatch(/^\|1\|[^|]+\|[^ ]+ ssh-ed25519 /);
  });

  it('reports the outcome through the debug log', async () => {
    const messages: string[] = [];
    const { deps: knownHosts } = deps(storedLine(OTHER_KEY));
    await verify(policy({ onDebug: (message) => messages.push(message) }), knownHosts, HOST_KEY);
    expect(messages.join('\n')).toContain('does NOT match known_hosts');
  });
});
