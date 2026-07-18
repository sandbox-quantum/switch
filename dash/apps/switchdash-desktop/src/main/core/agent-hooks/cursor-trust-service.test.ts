import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorTrustService } from './cursor-trust-service';

const mockAccess = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  promises: {
    access: mockAccess,
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
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

function nodeNotFound() {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function makeService(overrides: { autoTrustWorktrees?: boolean } = {}): CursorTrustService {
  return new CursorTrustService({
    getSessionSettings: () =>
      Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? true }),
  });
}

describe('CursorTrustService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue(nodeNotFound());
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('skips non-Cursor providers', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips when auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'cursor',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('trusts Cursor workspaces when forced even if auto-trust is disabled', async () => {
    const service = makeService({ autoTrustWorktrees: false });

    await service.maybeAutoTrustLocal({
      providerId: 'cursor',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    });

    expect(mockAccess).toHaveBeenCalledWith(
      '/home/local-user/.cursor/locations/tmp-worktree/.workspace-trusted'
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('writes the local Cursor workspace trust marker when missing', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'cursor',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    const markerPath = '/home/local-user/.cursor/locations/tmp-worktree/.workspace-trusted';
    expect(mockAccess).toHaveBeenCalledWith(markerPath);
    expect(mockMkdir).toHaveBeenCalledWith('/home/local-user/.cursor/locations/tmp-worktree', {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(markerPath, expect.any(String), 'utf8');

    const marker = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(marker).toEqual({
      trustedAt: expect.any(String),
      workspacePath: '/tmp/worktree',
      trustMethod: 'switchdash-auto-trust',
    });
  });

  it('is idempotent when the local marker already exists', async () => {
    const service = makeService();
    mockAccess.mockResolvedValue(undefined);

    await service.maybeAutoTrustLocal({
      providerId: 'cursor',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('matches Cursor CLI workspace trust directory derivation for long workspace paths', async () => {
    const service = makeService();

    await service.maybeAutoTrustLocal({
      providerId: 'cursor',
      cwd: '/Users/janburzinski/switchdash/worktrees/switchdash-official/tough-falcons-notice',
      homedir: '/Users/janburzinski',
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/Users/janburzinski/.cursor/locations/Users-janburzinski-switchdash-worktrees-switchdash-official-tough-falcons-notice/.workspace-trusted',
      expect.any(String),
      'utf8'
    );
  });
});
