import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSpawnOptions } from '@main/core/pty/local-pty';
import type { Pty } from '@main/core/pty/pty';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import {
  classifyInstallCommandFailure,
  createLocalInstallCommandRunner,
  runLocalInstallCommand,
} from './install-runner';

const mocks = vi.hoisted(() => ({
  spawnLocalPty: vi.fn(),
  ensureUserBinDirsInPath: vi.fn(),
}));

vi.mock('@main/core/pty/local-pty', () => ({
  spawnLocalPty: mocks.spawnLocalPty,
}));

vi.mock('@main/utils/userEnv', () => ({
  ensureUserBinDirsInPath: mocks.ensureUserBinDirsInPath,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function createSuccessfulPty(): Pty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler) => handler({ exitCode: 0 })),
  };
}

const cmdProfile: ResolvedShellProfile = {
  id: 'target-default',
  resolvedShellId: 'cmd',
  resolvedFromSystem: true,
  executable: 'C:\\Windows\\System32\\cmd.exe',
  available: true,
  family: 'windows-cmd',
  interactiveArgs: [],
  commandArgs: ['/d', '/s', '/c'],
};

const pwshProfile: ResolvedShellProfile = {
  id: 'pwsh',
  resolvedShellId: 'pwsh',
  resolvedFromSystem: false,
  executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  available: true,
  family: 'powershell',
  interactiveArgs: [],
  commandArgs: ['-NoLogo', '-Command'],
};

const posixProfile: ResolvedShellProfile = {
  id: 'zsh',
  resolvedShellId: 'zsh',
  resolvedFromSystem: true,
  executable: '/bin/zsh',
  available: true,
  family: 'posix',
  interactiveArgs: ['-il'],
  commandArgs: ['-c'],
};

beforeEach(() => {
  mocks.spawnLocalPty.mockReturnValue(createSuccessfulPty());
});

afterEach(() => {
  process.env = { ...originalEnv };
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  vi.clearAllMocks();
});

describe('classifyInstallCommandFailure', () => {
  it('summarizes permission errors from npm global installs', () => {
    expect(
      classifyInstallCommandFailure({
        exitCode: 243,
        output:
          '\u001b[1mnpm\u001b[22m \u001b[31merror\u001b[39m code EACCES\nnpm error path /usr/lib/node_modules/@openai\npermission denied',
      })
    ).toEqual({
      type: 'permission-denied',
      exitCode: 243,
      output:
        'npm error code EACCES\nnpm error path /usr/lib/node_modules/@openai\npermission denied',
      message: 'User does not have sufficient permissions.',
    });
  });

  it('returns command-failed for non-permission failures', () => {
    expect(
      classifyInstallCommandFailure({
        exitCode: 1,
        output: 'network unavailable',
      })
    ).toEqual({
      type: 'command-failed',
      exitCode: 1,
      output: 'network unavailable',
      message: 'Install command failed.',
    });
  });
});

describe('runLocalInstallCommand', () => {
  it('runs Windows installs through the local PTY platform resolver', async () => {
    setPlatform('win32');
    delete process.env.SHELL;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    const result = await runLocalInstallCommand('npm install -g @openai/codex', cmdProfile);

    expect(result.success).toBe(true);
    expect(mocks.spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'npm install -g @openai/codex'],
        cwd: expect.any(String),
      } satisfies Partial<LocalSpawnOptions>)
    );
  });

  it('runs Windows installs through the preferred automation PowerShell', async () => {
    setPlatform('win32');

    const result = await runLocalInstallCommand('npm install -g @openai/codex', pwshProfile);

    expect(result.success).toBe(true);
    expect(mocks.spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        args: ['-NoLogo', '-Command', 'npm install -g @openai/codex'],
        cwd: expect.any(String),
      } satisfies Partial<LocalSpawnOptions>)
    );
  });

  it('keeps an argv spec as argv, so a spaced Windows shim path is not split', async () => {
    setPlatform('win32');
    delete process.env.SHELL;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    const result = await runLocalInstallCommand(
      { command: 'C:\\Program Files\\nodejs\\npm.cmd', args: ['uninstall', '-g', '@openai/codex'] },
      cmdProfile
    );

    expect(result.success).toBe(true);
    expect(mocks.spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          '""C:\\Program Files\\nodejs\\npm.cmd" uninstall -g @openai/codex"',
        ],
      } satisfies Partial<LocalSpawnOptions>)
    );
  });

  it('quotes an argv spec for the POSIX shell', async () => {
    setPlatform('darwin');

    const result = await runLocalInstallCommand(
      { command: '/usr/local/bin/claude', args: ['custom-remove', '--force'] },
      posixProfile
    );

    expect(result.success).toBe(true);
    expect(mocks.spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-c', '/usr/local/bin/claude custom-remove --force'],
      } satisfies Partial<LocalSpawnOptions>)
    );
  });

  it('resolves the local install shell outside the low-level runner', async () => {
    setPlatform('win32');
    const resolveShellProfile = vi.fn(async () => pwshProfile);
    const runner = createLocalInstallCommandRunner(resolveShellProfile);

    const result = await runner('npm install -g @openai/codex');

    expect(result.success).toBe(true);
    expect(resolveShellProfile).toHaveBeenCalledWith();
    expect(mocks.spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      })
    );
  });
});
