import path from 'node:path';
import * as toml from 'smol-toml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexTrustService } from './codex-trust-service';

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
  log: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONFIG_PATH = '/home/local-user/.codex/config.toml';

function makeService(overrides: { autoTrustWorktrees?: boolean } = {}): CodexTrustService {
  return new CodexTrustService({
    getSessionSettings: () =>
      Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? true }),
    log: { warn: mockWarn },
  });
}

function writtenConfig(): string {
  expect(mockRename.mock.calls.map(([, target]) => String(target))).toContain(CONFIG_PATH);
  return String(mockWriteFile.mock.calls[0][1]);
}

async function trust(service: CodexTrustService, cwd: string, force?: boolean): Promise<void> {
  await service.maybeAutoTrustLocal({
    providerId: 'codex',
    cwd,
    homedir: '/home/local-user',
    ...(force === undefined ? {} : { force }),
  });
}

describe('CodexTrustService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('ignores providers other than Codex', async () => {
    await trust(makeService(), '/tmp/worktree');
    await makeService().maybeAutoTrustLocal({
      providerId: 'claude',
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('skips when auto-trust is disabled, and writes anyway when forced', async () => {
    await trust(makeService({ autoTrustWorktrees: false }), '/tmp/worktree');
    expect(mockWriteFile).not.toHaveBeenCalled();

    await trust(makeService({ autoTrustWorktrees: false }), '/tmp/worktree', true);
    expect(toml.parse(writtenConfig())).toEqual({
      projects: { '/tmp/worktree': { trust_level: 'trusted' } },
    });
  });

  it('writes the resolved absolute path, never an ancestor', async () => {
    await trust(makeService(), './relative/worktree');

    const parsed = toml.parse(writtenConfig()) as { projects: Record<string, unknown> };
    expect(Object.keys(parsed.projects)).toEqual([path.resolve('./relative/worktree')]);
  });

  it('appends to an existing config without disturbing what is already there', async () => {
    const existing = [
      '# my own notes',
      'model = "gpt-5.6-sol"',
      '',
      '[projects."/other/repo"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    mockReadFile.mockResolvedValue(existing);

    await trust(makeService(), '/tmp/worktree');

    const content = writtenConfig();
    expect(content).toContain('# my own notes');
    expect(content).toContain('model = "gpt-5.6-sol"');
    expect(toml.parse(content)).toEqual({
      model: 'gpt-5.6-sol',
      projects: {
        '/other/repo': { trust_level: 'trusted' },
        '/tmp/worktree': { trust_level: 'trusted' },
      },
    });
  });

  it('is idempotent once the directory is trusted', async () => {
    mockReadFile.mockResolvedValue('[projects."/tmp/worktree"]\ntrust_level = "trusted"\n');

    await trust(makeService(), '/tmp/worktree');

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('never flips a directory the user marked untrusted', async () => {
    mockReadFile.mockResolvedValue('[projects."/tmp/worktree"]\ntrust_level = "untrusted"\n');

    await trust(makeService(), '/tmp/worktree');

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('refuses to edit a corrupt config and says so', async () => {
    mockReadFile.mockResolvedValue('[projects."/tmp/worktree"\n= = =');

    await trust(makeService(), '/tmp/worktree');

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'CodexTrustService: refusing to edit corrupt Codex config',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('refuses to append when the project is declared without a trust level', async () => {
    mockReadFile.mockResolvedValue('[projects."/tmp/worktree"]\nsomething_else = 1\n');

    await trust(makeService(), '/tmp/worktree');

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'CodexTrustService: Codex config already declares this project without a trust level',
      { path: '/tmp/worktree' }
    );
  });

  it('escapes paths that would otherwise break the TOML key', async () => {
    const awkward = '/tmp/we"ird\\path';
    await trust(makeService(), awkward);

    const parsed = toml.parse(writtenConfig()) as { projects: Record<string, unknown> };
    expect(parsed.projects[path.resolve(awkward)]).toEqual({ trust_level: 'trusted' });
  });
});
