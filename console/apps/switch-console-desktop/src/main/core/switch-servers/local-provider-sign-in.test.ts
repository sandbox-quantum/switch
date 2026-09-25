import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOpenCodeLoginCommand } from './local-opencode-sign-in';
import {
  getLocalProviderSignIn,
  localProviderAuthPath,
  readLocalProviderSignIn,
} from './local-provider-sign-in';

vi.mock('./local-opencode-sign-in', () => ({
  localOpenCodeDatabasePath: () => '/fixture/opencode.db',
  readOpenCodeConsole: () => null,
  getOpenCodeLoginCommand: vi.fn(async () => ({
    version: '2.0.0',
    command: 'opencode auth login opencode',
  })),
}));

let home: string;
const subscription = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    access_token: 'placeholder-access',
    refresh_token: 'placeholder-refresh',
    id_token: 'placeholder-identity',
  },
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-auth-detection-'));
  vi.stubEnv('CODEX_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('local Codex subscription detection', () => {
  it('uses CODEX_HOME and detects later writes without exposing credentials', async () => {
    const path = join(home, 'auth.json');
    expect(localProviderAuthPath('codex')).toBe(path);
    expect(await getLocalProviderSignIn('codex')).toEqual({ path, status: 'missing' });
    await writeFile(path, JSON.stringify(subscription));
    expect(await getLocalProviderSignIn('codex')).toEqual({ path, status: 'ready' });
    expect(await readLocalProviderSignIn('codex', path)).toBe(JSON.stringify(subscription));
    await rm(path);
    expect(await getLocalProviderSignIn('codex')).toEqual({ path, status: 'missing' });
  });
  it('keeps partial contents out of errors and detects the completed write', async () => {
    await writeFile(localProviderAuthPath('codex'), '{"placeholder-private-content":');
    await expect(getLocalProviderSignIn('codex')).rejects.toThrow('Waiting for Codex');
    await writeFile(localProviderAuthPath('codex'), JSON.stringify(subscription));
    expect((await getLocalProviderSignIn('codex')).status).toBe('ready');
  });
  it.each([
    { OPENAI_API_KEY: 'placeholder-api-key' },
    { ...subscription, auth_mode: 'apikey' },
    { ...subscription, tokens: { ...subscription.tokens, refresh_token: '' } },
    [],
  ])('rejects API-only or incomplete subscription data', async (value) => {
    await writeFile(localProviderAuthPath('codex'), JSON.stringify(value));
    await expect(getLocalProviderSignIn('codex')).rejects.toThrow('Sign in to Codex with ChatGPT');
  });
  it('rejects oversized files before reading their contents', async () => {
    await writeFile(localProviderAuthPath('codex'), 'x'.repeat(16385));
    await expect(getLocalProviderSignIn('codex')).rejects.toThrow('smaller than 16 KiB');
  });
});

describe.each(['opencode', 'antigravity'] as const)('local %s sign-in detection', (provider) => {
  beforeEach(() => {
    vi.stubEnv('XDG_DATA_HOME', home);
    vi.stubEnv('GEMINI_HOME', home);
  });
  it('detects later writes and removal without returning credentials', async () => {
    const path = localProviderAuthPath(provider);
    expect(path).toBe(
      join(home, provider === 'opencode' ? 'opencode/auth.json' : 'antigravity-acp/acp_token.json')
    );
    expect(await getLocalProviderSignIn(provider)).toMatchObject({ path, status: 'missing' });
    await mkdir(dirname(path), { recursive: true });
    const credential = JSON.stringify(
      provider === 'opencode'
        ? { opencode: { type: 'api', key: 'fixture-only' } }
        : { placeholder: 'fixture-only' }
    );
    await writeFile(path, credential);
    expect(await getLocalProviderSignIn(provider)).toMatchObject({ path, status: 'ready' });
    expect(await readLocalProviderSignIn(provider, path)).toBe(credential);
    await rm(path);
    expect((await getLocalProviderSignIn(provider)).status).toBe('missing');
  });
  it.each(['{}', '[]', 'null', '"placeholder"', '{"private-content":', 'x'.repeat(16385)])(
    'rejects invalid data without exposing contents (case %#)',
    async (value) => {
      const path = localProviderAuthPath(provider);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value);
      await expect(getLocalProviderSignIn(provider)).rejects.toThrow();
      try {
        await getLocalProviderSignIn(provider);
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
      await writeFile(
        path,
        JSON.stringify(
          provider === 'opencode'
            ? { opencode: { type: 'api', key: 'fixture-only' } }
            : { placeholder: 'fixture-only' }
        )
      );
      expect((await getLocalProviderSignIn(provider)).status).toBe('ready');
    }
  );
});

it('uploads only the OpenCode entry from a shared auth file', async () => {
  const path = join(home, 'auth.json');
  await writeFile(
    path,
    JSON.stringify({
      opencode: { type: 'api', key: 'fixture-only' },
      unrelated: { type: 'api', key: 'must-stay-local' },
    })
  );
  expect(JSON.parse((await readLocalProviderSignIn('opencode', path))!)).toEqual({
    opencode: { type: 'api', key: 'fixture-only' },
  });
});

it('retries a sign-in file that is still being written', async () => {
  const path = join(home, 'auth.json');
  await writeFile(path, '{');
  const reading = readLocalProviderSignIn('codex', path);
  await delay(30);
  await writeFile(path, JSON.stringify(subscription));
  expect(await reading).toBe(JSON.stringify(subscription));
});

it('still detects an OpenCode login when CLI detection fails, with a visible warning', async () => {
  vi.stubEnv('XDG_DATA_HOME', home);
  const path = localProviderAuthPath('opencode');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ opencode: { type: 'api', key: 'fixture-only' } }));
  vi.mocked(getOpenCodeLoginCommand).mockRejectedValueOnce(new Error('CLI detection unavailable'));
  expect(await getLocalProviderSignIn('opencode')).toMatchObject({
    status: 'ready',
    path,
    detectionWarning: expect.stringContaining('CLI detection unavailable'),
  });
});
