import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTrustService } from './claude-trust-service';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockRename = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    rename: mockRename,
    rm: mockRm,
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

function makeService(overrides: { autoTrustWorktrees?: boolean } = {}): ClaudeTrustService {
  return new ClaudeTrustService({
    getSessionSettings: () =>
      Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? true }),
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
      providerId: 'codex',
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
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
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
    expect(written.locations[path.resolve(relPath)]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedLocationOnboarding: true,
    });
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
        locations: {
          [trustedPath]: {
            hasTrustDialogAccepted: true,
            hasCompletedLocationOnboarding: true,
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
    expect(secondWriteContent.locations[path.resolve('/worktree/a')]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedLocationOnboarding: true,
    });
    expect(secondWriteContent.locations[path.resolve('/worktree/b')]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedLocationOnboarding: true,
    });
  });
});
