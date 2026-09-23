import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLocalCodexSubscription,
  localCodexAuthPath,
  readLocalCodexSubscription,
} from './local-codex-subscription';

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
    expect(localCodexAuthPath()).toBe(path);
    expect(await getLocalCodexSubscription()).toEqual({ path, status: 'missing' });
    await writeFile(path, JSON.stringify(subscription));
    expect(await getLocalCodexSubscription()).toEqual({ path, status: 'ready' });
    expect(await readLocalCodexSubscription(path)).toBe(JSON.stringify(subscription));
    await rm(path);
    expect(await getLocalCodexSubscription()).toEqual({ path, status: 'missing' });
  });
  it('keeps partial contents out of errors and detects the completed write', async () => {
    await writeFile(localCodexAuthPath(), '{"placeholder-private-content":');
    await expect(getLocalCodexSubscription()).rejects.toThrow('Waiting for Codex');
    await writeFile(localCodexAuthPath(), JSON.stringify(subscription));
    expect((await getLocalCodexSubscription()).status).toBe('ready');
  });
  it.each([
    { OPENAI_API_KEY: 'placeholder-api-key' },
    { ...subscription, auth_mode: 'apikey' },
    { ...subscription, tokens: { ...subscription.tokens, refresh_token: '' } },
    [],
  ])('rejects API-only or incomplete subscription data', async (value) => {
    await writeFile(localCodexAuthPath(), JSON.stringify(value));
    await expect(getLocalCodexSubscription()).rejects.toThrow('Sign in to Codex with ChatGPT');
  });
  it('rejects oversized files before reading their contents', async () => {
    await writeFile(localCodexAuthPath(), 'x'.repeat(16385));
    await expect(getLocalCodexSubscription()).rejects.toThrow('smaller than 16 KiB');
  });
});
