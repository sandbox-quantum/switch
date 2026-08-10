import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const spawnLocalPty = vi.hoisted(() =>
  vi.fn((_options: { args: string[]; env: Record<string, string> }) => ({ id: 'pty' }))
);
const register = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:util', () => ({ promisify: () => execFileMock }));
vi.mock('@main/core/pty/local-pty', () => ({ spawnLocalPty }));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { register } }));
vi.mock('@main/core/updates/github-token', () => ({ GH_EXECUTABLE: 'gh' }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { probeLocalGhAuth, startLocalGhAuth } = await import('./local-gh-auth');

function ghStatus(...entries: Record<string, unknown>[]): string {
  return JSON.stringify({ hosts: { 'github.com': entries } });
}

const KEYRING = '/home/u/.config/gh/hosts.yml';

const HEALTHY = ghStatus({
  state: 'success',
  active: true,
  login: 'octocat',
  tokenSource: KEYRING,
  scopes: 'repo, read:packages',
});

beforeEach(() => {
  execFileMock.mockReset();
  spawnLocalPty.mockClear();
  register.mockClear();
});

describe('probeLocalGhAuth', () => {
  it('reports a usable login', async () => {
    execFileMock.mockResolvedValue({ stdout: HEALTHY, stderr: '' });
    expect(await probeLocalGhAuth()).toEqual({
      ghInstalled: true,
      authenticated: true,
      canReadPackages: true,
      account: 'octocat',
      envShadowed: false,
      detail: null,
    });
  });

  it('reports a login that cannot read packages', async () => {
    execFileMock.mockResolvedValue({
      stdout: ghStatus({
        state: 'success',
        active: true,
        login: 'octocat',
        tokenSource: KEYRING,
        scopes: 'repo',
      }),
      stderr: '',
    });
    const status = await probeLocalGhAuth();
    expect(status).toMatchObject({ authenticated: true, canReadPackages: false });
    expect(status.detail).toContain('read:packages');
  });

  // A token the API rejects is no better than none, and calling it
  // authenticated sends the user looking in the wrong place.
  it('reports a rejected token as not authenticated, and names the shadowing', async () => {
    execFileMock.mockResolvedValue({
      stdout: ghStatus({
        state: 'error',
        active: true,
        login: '',
        tokenSource: 'GH_TOKEN',
        error: '401 Unauthorized',
      }),
      stderr: '',
    });
    expect(await probeLocalGhAuth()).toMatchObject({
      authenticated: false,
      envShadowed: true,
      detail: '401 Unauthorized',
    });
  });

  it('reports a missing gh binary distinctly from a missing login', async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(await probeLocalGhAuth()).toMatchObject({
      ghInstalled: false,
      authenticated: false,
    });
  });

  it('treats a non-zero exit as no login', async () => {
    execFileMock.mockRejectedValue(new Error('exit 1'));
    expect(await probeLocalGhAuth()).toMatchObject({
      ghInstalled: true,
      authenticated: false,
      detail: 'Not logged in to GitHub.',
    });
  });

  // Reporting a fault we cannot see would block setup for a working install.
  it('assumes ready when the output cannot be understood', async () => {
    execFileMock.mockResolvedValue({ stdout: 'gh: unknown flag --json', stderr: '' });
    expect(await probeLocalGhAuth()).toMatchObject({
      ghInstalled: true,
      authenticated: true,
      canReadPackages: true,
    });
  });
});

describe('startLocalGhAuth', () => {
  it('refreshes when already logged in, asking for the scope', async () => {
    execFileMock.mockResolvedValue({ stdout: HEALTHY, stderr: '' });
    await startLocalGhAuth();
    const { args } = spawnLocalPty.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(['auth', 'refresh']);
    expect(args).toContain('read:packages');
  });

  it('logs in when there is no login, asking for the scope', async () => {
    execFileMock.mockRejectedValue(new Error('exit 1'));
    await startLocalGhAuth();
    const { args } = spawnLocalPty.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(['auth', 'login']);
    expect(args).toContain('read:packages');
  });

  // gh prefers these over the keyring, so `gh auth refresh` would act on the
  // environment token — the very thing the user is trying to get past.
  it('runs without the environment tokens that would shadow the keyring', async () => {
    execFileMock.mockResolvedValue({ stdout: HEALTHY, stderr: '' });
    process.env.GH_TOKEN = 'stale';
    process.env.GITHUB_TOKEN = 'stale';
    try {
      await startLocalGhAuth();
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    }
    const { env } = spawnLocalPty.mock.calls[0][0];
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('refuses when gh is not installed, naming where to get it', async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(startLocalGhAuth()).rejects.toThrow(/cli\.github\.com/);
    expect(spawnLocalPty).not.toHaveBeenCalled();
  });
});
