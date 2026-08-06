import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentSecretRelativePath,
  createLocalAgentSecretStore,
  createRemoteAgentSecretStore,
} from './switch-agent-secrets';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'switch-secrets-test-'));
  roots.push(dir);
  return dir;
}

describe('createLocalAgentSecretStore', () => {
  it('round-trips a token', async () => {
    const store = createLocalAgentSecretStore(home());
    await store.write('uuid-1', 'tok-abc');

    expect(await store.read('uuid-1')).toBe('tok-abc');
  });

  it('writes the secret 0600 and its directory 0700', async () => {
    const root = home();
    await createLocalAgentSecretStore(root).write('uuid-1', 'tok-abc');

    const file = path.join(root, agentSecretRelativePath('uuid-1'));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('tightens the mode of a file that already existed too open', async () => {
    // `writeFile`'s mode applies only on create, so a rewrite would otherwise
    // leave a token sitting in a world-readable file.
    const root = home();
    const store = createLocalAgentSecretStore(root);
    const file = path.join(root, agentSecretRelativePath('uuid-1'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'stale', { mode: 0o644 });

    await store.write('uuid-1', 'tok-new');

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.read('uuid-1')).toBe('tok-new');
  });

  it('reads absent, malformed and empty secrets as no secret', async () => {
    const root = home();
    const store = createLocalAgentSecretStore(root);
    expect(await store.read('missing')).toBeNull();

    const file = path.join(root, agentSecretRelativePath('broken'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    expect(await store.read('broken')).toBeNull();

    await fs.writeFile(path.join(root, agentSecretRelativePath('empty')), '{"token":"  "}');
    expect(await store.read('empty')).toBeNull();
  });

  it('deletes, and deleting a missing secret is not an error', async () => {
    const root = home();
    const store = createLocalAgentSecretStore(root);
    await store.write('uuid-1', 'tok-abc');
    await store.delete('uuid-1');

    expect(await store.read('uuid-1')).toBeNull();
    await expect(store.delete('uuid-1')).resolves.toBeUndefined();
  });

  it('keys by agent id, so two agents never share a file', async () => {
    const root = home();
    const store = createLocalAgentSecretStore(root);
    await store.write('uuid-a', 'tok-a');
    await store.write('uuid-b', 'tok-b');

    expect(await store.read('uuid-a')).toBe('tok-a');
    expect(await store.read('uuid-b')).toBe('tok-b');
  });
});

describe('createRemoteAgentSecretStore', () => {
  it('never puts the token in the command string', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' });
    await createRemoteAgentSecretStore({ exec }).write('uuid-1', 'tok-secret');

    const [, args] = exec.mock.calls[0] as [string, string[]];
    expect(args[1]).not.toContain('tok-secret');
    expect(args).toContain('.switch/agents/uuid-1.json');
    // It reaches the far side only base64-encoded, as a positional argument.
    const payload = Buffer.from(args[args.length - 1], 'base64').toString('utf8');
    expect(JSON.parse(payload)).toEqual({ token: 'tok-secret' });
  });

  it('sets the umask before writing rather than chmod-ing afterwards', async () => {
    // A write-then-chmod leaves the token world-readable in between.
    const exec = vi.fn().mockResolvedValue({ stdout: '' });
    await createRemoteAgentSecretStore({ exec }).write('uuid-1', 'tok');

    const script = (exec.mock.calls[0] as [string, string[]])[1][1];
    expect(script.indexOf('umask 077')).toBeLessThan(script.indexOf('>'));
    expect(script).toContain('chmod 600');
  });

  it('decodes a token the far side base64-encoded', async () => {
    const body = Buffer.from(JSON.stringify({ token: 'tok-remote' }), 'utf8').toString('base64');
    const exec = vi.fn().mockResolvedValue({ stdout: `1${body}` });

    expect(await createRemoteAgentSecretStore({ exec }).read('uuid-1')).toBe('tok-remote');
  });

  it('reads a missing file as no secret', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '0' });

    expect(await createRemoteAgentSecretStore({ exec }).read('uuid-1')).toBeNull();
  });

  it('fails loudly on a response it cannot interpret', async () => {
    // Silence here would look identical to "this agent has no secret", and the
    // caller would go on to provision a session with no identity.
    const exec = vi.fn().mockResolvedValue({ stdout: 'ssh: connection closed' });

    await expect(createRemoteAgentSecretStore({ exec }).read('uuid-1')).rejects.toThrow(
      /unreadable response/
    );
  });

  it('refuses an agent id that could break out of the command', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' });
    const store = createRemoteAgentSecretStore({ exec });

    await expect(store.write('../../etc/passwd', 'tok')).rejects.toThrow(/unsafe agent id/);
    await expect(store.read('a b; rm -rf /')).rejects.toThrow(/unsafe agent id/);
    expect(exec).not.toHaveBeenCalled();
  });
});
