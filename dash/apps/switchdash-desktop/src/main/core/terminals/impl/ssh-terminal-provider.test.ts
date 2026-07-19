import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { PtyExitInfo } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { openSsh2Pty } from '@main/core/pty/ssh2-pty';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { Terminal } from '@shared/core/terminals/terminals';
import { SshTerminalProvider } from './ssh-terminal-provider';

const ptyMock = vi.hoisted(() => ({
  exitHandlers: [] as Array<(info: PtyExitInfo) => void>,
}));

vi.mock('@main/core/pty/ssh2-pty', () => ({
  openSsh2Pty: vi.fn(async () => ({
    success: true,
    data: {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((handler: (info: PtyExitInfo) => void) => {
        ptyMock.exitHandlers.push(handler);
      }),
    },
  })),
}));

vi.mock('@main/core/pty/pty-session-registry', () => ({
  ptySessionRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
  },
}));

vi.mock('@main/core/pty/terminal-color-scheme', () => ({
  getTerminalColorEnv: vi.fn().mockResolvedValue({}),
}));

const terminal: Terminal = {
  id: 'terminal-1',
  locationId: 'location-1',
  sessionId: 'session-1',
  shellId: 'system',
  name: 'Terminal 1',
};

const ctx = {
  supportsLocalSpawn: false,
  exec: vi.fn(),
  execStreaming: vi.fn(),
  dispose: vi.fn(),
} satisfies IExecutionContext;

const proxy = {
  getRemoteShellProfile: vi.fn(async () => ({
    shell: '/bin/bash',
    env: { PATH: '/usr/bin', HOME: '/home/me' },
  })),
} satisfies Partial<SshClientProxy> as unknown as SshClientProxy;

describe('SshTerminalProvider', () => {
  beforeEach(() => {
    ptyMock.exitHandlers.length = 0;
    vi.mocked(ptySessionRegistry.register).mockClear();
    vi.mocked(ptySessionRegistry.unregister).mockClear();
    vi.mocked(openSsh2Pty).mockClear();
    proxy.getRemoteShellProfile = vi.fn(async () => ({
      shell: '/bin/bash',
      env: { PATH: '/usr/bin', HOME: '/home/me' },
    }));
  });

  it('cleans up cached shell profiles after a non-respawned exit', async () => {
    const provider = new SshTerminalProvider({
      scopeId: terminal.sessionId,
      sessionPath: '/repo',
      ctx,
      proxy,
    });

    await provider.spawnLifecycleScript({
      terminal,
      command: 'echo ready',
    });

    const sessionId = makePtySessionId(terminal.locationId, terminal.sessionId, terminal.id);
    expect(
      (provider as unknown as { shellProfiles: Map<string, unknown> }).shellProfiles.has(sessionId)
    ).toBe(true);

    for (const handler of ptyMock.exitHandlers) handler({ exitCode: 0 });

    expect(
      (provider as unknown as { shellProfiles: Map<string, unknown> }).shellProfiles.has(sessionId)
    ).toBe(false);
  });

  it('registers lifecycle-script ptys as remote for resource monitor labels', async () => {
    const provider = new SshTerminalProvider({
      scopeId: terminal.sessionId,
      sessionPath: '/repo',
      ctx,
      proxy,
    });

    await provider.spawnLifecycleScript({
      terminal,
      command: 'echo ready',
    });

    const sessionId = makePtySessionId(terminal.locationId, terminal.sessionId, terminal.id);
    expect(ptySessionRegistry.register).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      expect.objectContaining({ metadata: { isRemote: true } })
    );
  });
});
