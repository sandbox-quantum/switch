import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import {
  resolveLocalAutomationShellWithSystemFallback,
  resolveTerminalShell,
  ShellUnavailableError,
} from './resolver';

describe('terminal shell resolver', () => {
  it('keeps system intent while recording the concrete local shell', async () => {
    const profile = await resolveTerminalShell({
      intent: 'system',
      target: {
        kind: 'local',
        platform: 'darwin',
        env: { SHELL: '/bin/zsh' },
      },
    });

    expect(profile).toMatchObject({
      id: 'target-default',
      resolvedShellId: 'zsh',
      resolvedFromSystem: true,
      executable: '/bin/zsh',
    });
  });

  it('keeps login-shell args for fish local system shells', async () => {
    const profile = await resolveTerminalShell({
      intent: 'system',
      target: {
        kind: 'local',
        platform: 'darwin',
        env: { SHELL: '/opt/homebrew/bin/fish' },
      },
    });

    expect(profile).toMatchObject({
      id: 'target-default',
      resolvedShellId: 'fish',
      resolvedFromSystem: true,
      executable: '/opt/homebrew/bin/fish',
      family: 'posix',
      commandArgs: ['-lc'],
    });
  });

  it('uses ComSpec as the Windows system shell', async () => {
    const profile = await resolveTerminalShell({
      intent: 'system',
      target: {
        kind: 'local',
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      },
    });

    expect(profile).toMatchObject({
      id: 'target-default',
      resolvedShellId: 'cmd',
      executable: 'C:\\Windows\\System32\\cmd.exe',
      family: 'windows-cmd',
    });
  });

  it('uses the latest installed pwsh for Windows automation shell fallback', async () => {
    const profile = await resolveLocalAutomationShellWithSystemFallback({
      intent: 'system',
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        ProgramFiles: 'C:\\Program Files',
        Path: 'C:\\Windows\\System32',
        PATHEXT: '.EXE;.CMD',
      },
      readDirNames: (candidate) =>
        candidate === 'C:\\Program Files\\PowerShell' ? ['7', '7.5.1', '6'] : [],
      fileExists: (candidate) =>
        candidate === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' ||
        candidate === 'C:\\Program Files\\PowerShell\\7.5.1\\pwsh.exe',
    });

    expect(profile).toMatchObject({
      id: 'pwsh',
      resolvedShellId: 'pwsh',
      executable: 'C:\\Program Files\\PowerShell\\7.5.1\\pwsh.exe',
      family: 'powershell',
    });
    expect(profile.commandArgs).toEqual(['-NoLogo', '-Command']);
  });

  it('keeps regular PowerShell command profiles non-profile-loading by default', async () => {
    const profile = await resolveTerminalShell({
      intent: 'pwsh',
      target: {
        kind: 'local',
        platform: 'win32',
        env: {
          Path: 'C:\\Program Files\\PowerShell\\7',
          PATHEXT: '.EXE;.CMD',
        },
      },
      fileExists: (candidate) => candidate === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    });

    expect(profile.commandArgs).toEqual(['-NoProfile', '-Command']);
  });

  it('resolves Windows bash to Git Bash instead of the WSL bash launcher', async () => {
    const profile = await resolveTerminalShell({
      intent: 'bash',
      target: {
        kind: 'local',
        platform: 'win32',
        env: {
          ProgramFiles: 'C:\\Program Files',
          Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin',
          PATHEXT: '.EXE;.CMD',
        },
      },
      fileExists: (candidate) =>
        candidate.toLowerCase() === 'c:\\windows\\system32\\bash.exe' ||
        candidate.toLowerCase() === 'c:\\program files\\git\\bin\\bash.exe',
    });

    expect(profile).toMatchObject({
      id: 'bash',
      resolvedShellId: 'bash',
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
      family: 'posix',
    });
  });

  it('resolves explicit WSL on Windows without POSIX shell args', async () => {
    const profile = await resolveTerminalShell({
      intent: 'wsl',
      target: {
        kind: 'local',
        platform: 'win32',
        env: {
          SystemRoot: 'C:\\Windows',
          Path: 'C:\\Windows\\System32',
          PATHEXT: '.EXE;.CMD',
        },
      },
      fileExists: (candidate) => candidate.toLowerCase() === 'c:\\windows\\system32\\wsl.exe',
    });

    expect(profile).toMatchObject({
      id: 'wsl',
      resolvedShellId: 'wsl',
      executable: 'C:\\Windows\\System32\\wsl.exe',
      family: 'wsl',
      commandArgs: ['--exec', 'sh', '-lc'],
    });
  });

  it('does not resolve explicit WSL from an arbitrary PATH entry on Windows', async () => {
    await expect(
      resolveTerminalShell({
        intent: 'wsl',
        target: {
          kind: 'local',
          platform: 'win32',
          env: {
            SystemRoot: 'C:\\Windows',
            Path: 'C:\\Tools',
            PATHEXT: '.EXE;.CMD',
          },
        },
        fileExists: (candidate) => candidate.toLowerCase() === 'c:\\tools\\wsl.exe',
      })
    ).rejects.toBeInstanceOf(ShellUnavailableError);
  });

  it('falls Windows automation shell back to Windows PowerShell before cmd', async () => {
    const profile = await resolveLocalAutomationShellWithSystemFallback({
      intent: 'system',
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: 'C:\\Windows\\System32',
        PATHEXT: '.EXE;.CMD',
      },
      fileExists: (candidate) => candidate === 'C:\\Windows\\System32\\powershell.exe',
    });

    expect(profile).toMatchObject({
      id: 'powershell',
      resolvedShellId: 'powershell',
      executable: 'C:\\Windows\\System32\\powershell.exe',
      family: 'powershell',
    });
  });

  it('does not retry a failed explicit pwsh lookup before falling back', async () => {
    const readDirNames = vi.fn((candidate: string) =>
      candidate === 'C:\\Program Files\\PowerShell' ? ['7'] : []
    );

    const profile = await resolveLocalAutomationShellWithSystemFallback({
      intent: 'pwsh',
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        ProgramFiles: 'C:\\Program Files',
        Path: 'C:\\Windows\\System32',
        PATHEXT: '.EXE;.CMD',
      },
      readDirNames,
      fileExists: (candidate) => candidate === 'C:\\Windows\\System32\\powershell.exe',
    });

    expect(profile).toMatchObject({
      id: 'powershell',
      executable: 'C:\\Windows\\System32\\powershell.exe',
    });
    expect(readDirNames).toHaveBeenCalledTimes(1);
  });

  it('reports each unavailable Windows automation fallback candidate', async () => {
    const onFallback = vi.fn();

    const profile = await resolveLocalAutomationShellWithSystemFallback({
      intent: 'pwsh',
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        ProgramFiles: 'C:\\Program Files',
        Path: 'C:\\Windows\\System32',
        PATHEXT: '.EXE;.CMD',
      },
      onFallback,
      fileExists: () => false,
    });

    expect(profile).toMatchObject({
      id: 'target-default',
      resolvedShellId: 'cmd',
    });
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback.mock.calls.map(([error]) => error.shell)).toEqual(['pwsh', 'powershell']);
  });

  it('throws for unavailable explicit local shells', async () => {
    await expect(
      resolveTerminalShell({
        intent: 'zsh',
        target: { kind: 'local', platform: 'linux', env: { PATH: '/usr/bin' } },
        fileExists: () => false,
      })
    ).rejects.toBeInstanceOf(ShellUnavailableError);
  });

  it('marks explicit remote shells for PATH lookup after availability succeeds', async () => {
    const proxy = {
      exec: vi.fn((_command, callback) => {
        callback(undefined, {
          on(event: string, handler: (code?: number | null) => void) {
            if (event === 'close') handler(0);
            return this;
          },
          stderr: { on: vi.fn() },
        });
      }),
    } as unknown as SshClientProxy;

    const profile = await resolveTerminalShell({
      intent: 'bash',
      target: {
        kind: 'ssh',
        proxy,
        profile: { shell: '/bin/zsh', env: { PATH: '/usr/local/bin:/usr/bin' } },
      },
    });

    expect(profile).toMatchObject({
      id: 'bash',
      resolvedShellId: 'bash',
      executable: 'bash',
      remotePathLookup: true,
    });
  });

  it('rejects explicit remote pwsh even when a proxy is provided', async () => {
    const proxy = { exec: vi.fn() } as unknown as SshClientProxy;

    await expect(
      resolveTerminalShell({
        intent: 'pwsh',
        target: {
          kind: 'ssh',
          proxy,
          profile: { shell: '/bin/zsh', env: { PATH: '/usr/local/bin:/usr/bin' } },
        },
      })
    ).rejects.toBeInstanceOf(ShellUnavailableError);
  });

  it('keeps fish as the remote system shell after normalization', async () => {
    const profile = await resolveTerminalShell({
      intent: 'system',
      target: {
        kind: 'ssh',
        profile: { shell: '/usr/local/bin/fish', env: { PATH: '/usr/local/bin:/usr/bin' } },
      },
    });

    expect(profile).toMatchObject({
      id: 'target-default',
      resolvedShellId: 'fish',
      resolvedFromSystem: true,
      executable: '/usr/local/bin/fish',
      commandArgs: ['-lc'],
    });
  });
});
