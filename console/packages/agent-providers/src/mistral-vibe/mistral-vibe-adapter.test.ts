import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  readFile: vi.fn(),
}));
const { readFile } = await import('node:fs/promises');
const { mistralVibeAcp, createMistralVibeAdapter } = await import('./mistral-vibe-adapter');

beforeEach(() => {
  vi.mocked(readFile).mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

const signInCheck = (env: Record<string, string>, handshake?: () => Promise<unknown>) =>
  mistralVibeAcp.checkSignIn!({
    binaryPath: 'vibe-acp',
    cwd: '/work',
    env,
    handshake: (handshake ?? (async () => ({ authMethods: [] }))) as never,
  });

it('launches vibe-acp with no arguments and the session environment', async () => {
  expect(
    await mistralVibeAcp.launch({ binaryPath: '/bin/vibe-acp', cwd: '/w', env: { A: '1' } })
  ).toEqual({ command: '/bin/vibe-acp', args: [], env: { A: '1' } });
});

it('is signed in from MISTRAL_API_KEY without starting a handshake', async () => {
  const handshake = vi.fn();
  const result = await signInCheck({ MISTRAL_API_KEY: 'synthetic-key' }, handshake as never);
  expect(result.status).toBe('authenticated');
  expect(handshake).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('synthetic-key');
});

it('is signed in from ~/.vibe/.env without starting a handshake', async () => {
  vi.mocked(readFile).mockResolvedValue('MISTRAL_API_KEY = from-file\n');
  const handshake = vi.fn();
  const result = await signInCheck({ HOME: '/home/u' }, handshake as never);
  expect(result.status).toBe('authenticated');
  expect(handshake).not.toHaveBeenCalled();
  expect(readFile).toHaveBeenCalledWith(expect.stringContaining('.vibe'), 'utf8');
});

it('treats a missing ~/.vibe/.env as nothing to read and asks the handshake', async () => {
  vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  const result = await signInCheck({ HOME: '/home/u' }, async () => ({ authMethods: [] }));
  expect(result.status).toBe('authenticated');
});

it('is unauthenticated when the handshake still offers auth methods', async () => {
  const result = await signInCheck({}, async () => ({ authMethods: [{ id: 'oauth-personal' }] }));
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('vibe --setup');
});

it('maps an auth-shaped handshake failure to unauthenticated', async () => {
  const result = await signInCheck({}, async () => {
    throw new Error('authentication required');
  });
  expect(result.status).toBe('unauthenticated');
});

it('never sends authenticate and never puts a key on the launch line', async () => {
  expect(mistralVibeAcp.authMethodId?.({ MISTRAL_API_KEY: 'k' })).toBeUndefined();
  expect(mistralVibeAcp.authMethodId?.({})).toBeUndefined();
  const launch = await mistralVibeAcp.launch({
    binaryPath: 'vibe-acp',
    cwd: '/w',
    env: { MISTRAL_API_KEY: 'k' },
  });
  expect(launch.args).toEqual([]);
  expect(JSON.stringify(launch)).not.toContain('synthetic');
});

it('exposes the provider id and login the registries hold', () => {
  expect(mistralVibeAcp.provider).toBe('mistral-vibe');
  expect(mistralVibeAcp.loginCommand).toBe('vibe --setup');
  expect(mistralVibeAcp.defaultBinary).toBe('vibe-acp');
  expect(createMistralVibeAdapter()).toBeDefined();
});
