import { beforeEach, expect, it, vi } from 'vitest';
import { auggieAcp } from './auggie-adapter';
import { checkAuggieSignIn, parseAuggieAuthStatus } from './runtime';

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('../provider-process', () => ({ execProvider: exec }));

const input = { binaryPath: 'auggie', cwd: '/work', env: { PATH: '/bin' } };

beforeEach(() => {
  exec.mockReset();
});

it('launches the Auggie CLI in ACP mode', async () => {
  expect(await auggieAcp.launch(input)).toEqual({
    command: 'auggie',
    args: ['--acp'],
    env: { PATH: '/bin' },
  });
});

it('recognises Auggie signed out even though auth status exits with code 1', () => {
  const result = parseAuggieAuthStatus('Not logged in.', 1);
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('auggie auth login');
});

it('recognises an authenticated status only on a successful command', () => {
  expect(parseAuggieAuthStatus('Logged in as developer@example.com', 0).status).toBe(
    'authenticated'
  );
  expect(parseAuggieAuthStatus('Logged in as developer@example.com', 1).status).toBe('unknown');
});

it('leaves unfamiliar auth output as unknown', () => {
  expect(parseAuggieAuthStatus('Authentication service unavailable', 0).status).toBe('unknown');
});

it('runs only the read-only auth status command', async () => {
  exec.mockRejectedValue(
    Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: 'Not logged in.',
      stderr: '',
    })
  );

  const result = await checkAuggieSignIn(input);

  expect(exec).toHaveBeenCalledWith(
    'auggie',
    ['auth', 'status'],
    expect.objectContaining({ cwd: '/work', env: input.env, timeout: 15_000 })
  );
  expect(result.status).toBe('unauthenticated');
});

it('recognises a signed-in CLI from a successful status command', async () => {
  exec.mockResolvedValue({ stdout: 'Logged in as developer@example.com', stderr: '' });
  await expect(checkAuggieSignIn(input)).resolves.toMatchObject({ status: 'authenticated' });
});