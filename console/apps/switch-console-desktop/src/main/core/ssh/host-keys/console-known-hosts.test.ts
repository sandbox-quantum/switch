import { describe, expect, it } from 'vitest';
import { ConsoleKnownHosts } from './console-known-hosts';
import { lookupHostKey } from './known-hosts';
import { ecdsaHostKey, ed25519HostKey } from './test-host-keys';

const { key: ECDSA_KEY } = ecdsaHostKey();
const { key: ED25519_KEY } = ed25519HostKey();
const ecdsa = Buffer.from(ECDSA_KEY, 'base64');
const ed25519 = Buffer.from(ED25519_KEY, 'base64');

function memoryStore(initial: string | null) {
  const files = new Map<string, string>();
  if (initial !== null) files.set('/data/ssh/known_hosts', initial);
  const store = new ConsoleKnownHosts(() => '/data/ssh/known_hosts', {
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return text;
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });
  return { store, files };
}

describe('ConsoleKnownHosts', () => {
  it('reads nothing before anything was trusted', async () => {
    const { store } = memoryStore(null);
    await expect(store.read()).resolves.toEqual([]);
  });

  it('records a trusted key so the next check finds it', async () => {
    const { store } = memoryStore(null);
    await store.trust('[example.test]:2222', ecdsa);
    const lines = await store.read();
    expect(lookupHostKey(lines, '[example.test]:2222', ecdsa)).toEqual({ status: 'match' });
  });

  it('replaces the key it had for the same name and keeps every other line', async () => {
    const { store, files } = memoryStore(
      `[example.test]:2222 ecdsa-sha2-nistp256 ${ECDSA_KEY}\nother.example.test ecdsa-sha2-nistp256 ${ECDSA_KEY}\n`
    );

    await store.trust('[example.test]:2222', ed25519);

    expect(files.get('/data/ssh/known_hosts')).toBe(
      `other.example.test ecdsa-sha2-nistp256 ${ECDSA_KEY}\n[example.test]:2222 ssh-ed25519 ${ED25519_KEY}\n`
    );
    const lines = await store.read();
    expect(lookupHostKey(lines, '[example.test]:2222', ecdsa).status).toBe('changed');
    expect(lookupHostKey(lines, '[example.test]:2222', ed25519).status).toBe('match');
  });

  it('runs concurrent trusts one after another so neither line is lost', async () => {
    const { store } = memoryStore(null);
    await Promise.all([
      store.trust('one.example.test', ecdsa),
      store.trust('two.example.test', ed25519),
    ]);
    const lines = await store.read();
    expect(lookupHostKey(lines, 'one.example.test', ecdsa).status).toBe('match');
    expect(lookupHostKey(lines, 'two.example.test', ed25519).status).toBe('match');
  });
});
