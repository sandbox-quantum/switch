import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTrustService } from './claude-trust-service';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockRename = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
// Trust keys are the resolved path; identity here keeps the fixtures literal.
const mockRealpath = vi.hoisted(() => vi.fn(async (p: string) => p));

vi.mock('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    rename: mockRename,
    rm: mockRm,
    realpath: mockRealpath,
  },
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: mockWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function renamedTo(): string[] {
  return mockRename.mock.calls.map(([, target]) => String(target));
}

function makeService(overrides: { autoTrustWorktrees?: boolean } = {}): ClaudeTrustService {
  return new ClaudeTrustService({
    getSessionSettings: () =>
      Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? true }),
    log: { warn: mockWarn },
  });
}

describe('ClaudeTrustService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('skips providers without trust config', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'opencode',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips when auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('trusts Claude worktrees when forced even if auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    expect(mockReadFile).toHaveBeenCalledWith('/home/local-user/.claude.json', 'utf8');
    expect(renamedTo()).toContain('/home/local-user/.claude.json');
  });

  it('accepts the bypass-permissions warning only when auto-approve forced the launch', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(renamedTo()).not.toContain('/tmp/worktree/.claude/settings.local.json');

    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    const settingsWrite = mockWriteFile.mock.calls.find(([tmpPath]) =>
      String(tmpPath).startsWith('/tmp/worktree/.claude/settings.local.json.')
    );
    expect(settingsWrite).toBeDefined();
    expect(JSON.parse(String(settingsWrite?.[1]))).toEqual({
      skipDangerousModePermissionPrompt: true,
    });
  });

  it('leaves Claude settings alone when the bypass warning is already accepted', async () => {
    const service = makeService();
    mockReadFile.mockImplementation(async (target: string) =>
      String(target).endsWith('.claude/settings.local.json')
        ? JSON.stringify({ skipDangerousModePermissionPrompt: true, model: 'opus' })
        : null
    );

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    expect(renamedTo()).not.toContain('/tmp/worktree/.claude/settings.local.json');
  });

  it('writes local config atomically when missing', async () => {
    const service = makeService();
    const relPath = './relative/path';

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: relPath,
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockMkdir).toHaveBeenCalledWith('/home/local-user', { recursive: true });
    expect(mockRename).toHaveBeenCalledTimes(1);

    const [tmpPath, content] = mockWriteFile.mock.calls[0];
    const [renameFrom, renameTo] = mockRename.mock.calls[0];
    expect(tmpPath).toContain('/home/local-user/.claude.json.');
    expect(tmpPath).toContain('.tmp');
    expect(renameFrom).toBe(tmpPath);
    expect(renameTo).toBe('/home/local-user/.claude.json');

    const written = JSON.parse(String(content));
    expect(written.projects[path.resolve(relPath)]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('keys trust to the resolved directory, not the symlink used to reach it', async () => {
    const service = makeService();
    mockRealpath.mockImplementation(async (p: string) =>
      p === '/link/to/worktree' ? '/real/worktree' : p
    );

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/link/to/worktree',
      homedir: '/home/local-user',
    });

    // A process asks the kernel where it is and gets the real path back, so a
    // CLI comparing its cwd against a trust entry never sees the link.
    const written = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(Object.keys(written.projects)).toEqual(['/real/worktree']);
  });

  it('leaves the global first-run setup wizard for the user to answer', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    const claudeJson = mockWriteFile.mock.calls.find(([tmpPath]) =>
      String(tmpPath).startsWith('/home/local-user/.claude.json.')
    );
    // That wizard is where a fresh install is told to connect an account.
    // Skipping it would trade a prompt that says what is missing for a session
    // that fails later without saying anything.
    expect(JSON.parse(String(claudeJson?.[1]))).not.toHaveProperty('hasCompletedOnboarding');
  });

  it('adds Copilot trusted folders', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue(JSON.stringify({ trustedFolders: ['/already/trusted'] }));

    await service.maybeAutoTrustLocal({
      providerId: 'copilot',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockMkdir).toHaveBeenCalledWith('/home/local-user/.copilot', { recursive: true });
    const [tmpPath, content] = mockWriteFile.mock.calls[0];
    const [renameFrom, renameTo] = mockRename.mock.calls[0];
    expect(tmpPath).toContain('/home/local-user/.copilot/config.json.');
    expect(renameFrom).toBe(tmpPath);
    expect(renameTo).toBe('/home/local-user/.copilot/config.json');
    expect(JSON.parse(String(content)).trustedFolders).toEqual([
      '/already/trusted',
      '/tmp/worktree',
    ]);
  });

  it('does not rewrite Copilot config when folder is already trusted', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue(JSON.stringify({ trustedFolders: ['/tmp/worktree'] }));

    await service.maybeAutoTrustLocal({
      providerId: 'copilot',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('is idempotent when already trusted', async () => {
    const service = makeService();
    const trustedPath = '/already/trusted';
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        projects: {
          [trustedPath]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })
    );

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: trustedPath,
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('refuses to overwrite corrupt JSON and logs a warning', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue('{ invalid json');

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'ClaudeTrustService: refusing to overwrite corrupt Claude config',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('refuses to overwrite non-object config root', async () => {
    const service = makeService();
    mockReadFile.mockResolvedValue(JSON.stringify([1, 2, 3]));

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'ClaudeTrustService: refusing to overwrite non-object Claude config root'
    );
  });

  it('serializes concurrent calls so no trust entry is lost', async () => {
    const service = makeService();
    let callCount = 0;

    mockReadFile.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null;
      const [, content] = mockWriteFile.mock.calls[0];
      return String(content);
    });

    await Promise.all([
      service.maybeAutoTrustLocal({
        providerId: 'claude',
        cwd: '/worktree/a',
        homedir: '/home/local-user',
      }),
      service.maybeAutoTrustLocal({
        providerId: 'claude',
        cwd: '/worktree/b',
        homedir: '/home/local-user',
      }),
    ]);

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    const secondWriteContent = JSON.parse(String(mockWriteFile.mock.calls[1][1]));
    expect(secondWriteContent.projects[path.resolve('/worktree/a')]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
    expect(secondWriteContent.projects[path.resolve('/worktree/b')]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });
});
