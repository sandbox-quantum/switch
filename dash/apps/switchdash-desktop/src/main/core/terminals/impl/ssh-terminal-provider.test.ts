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

vi.mock('@main/core/ssh/lifecycle/production-ssh-connection-manager', () => ({
  sshConnectionManager: {
    on: vi.fn(),
    off: vi.fn(),
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

  const ptyFromCall = async (index: number): Promise<{ kill: ReturnType<typeof vi.fn> }> => {
    const result = vi.mocked(openSsh2Pty).mock.results[index]!;
    const value = (await result.value) as { data: { kill: ReturnType<typeof vi.fn> } };
    return value.data;
  };

  it('re-attaches a terminal whose stale session is still mapped after a reconnect', async () => {
    const provider = new SshTerminalProvider({
      locationId: terminal.locationId,
      scopeId: terminal.sessionId,
      sessionPath: '/repo',
      ctx,
      proxy,
      connectionId: 'ssh-1',
    });

    await provider.spawnTerminal(terminal);
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    const stalePty = await ptyFromCall(0);
    const sessionId = makePtySessionId(terminal.locationId, terminal.sessionId, terminal.id);

    // The dead channel's `close` has not fired, so the session is still mapped.
    await provider.rehydrate();

    // Re-spawned despite the lingering session, and the stale channel was torn
    // down locally (pty killed + unregistered) without touching remote tmux.
    expect(openSsh2Pty).toHaveBeenCalledTimes(2);
    expect(stalePty.kill).toHaveBeenCalled();
    expect(ptySessionRegistry.unregister).toHaveBeenCalledWith(sessionId, { pty: stalePty });
  });

  it('ignores a late exit from a discarded pty so it does not tear down the replacement', async () => {
    const provider = new SshTerminalProvider({
      locationId: terminal.locationId,
      scopeId: terminal.sessionId,
      sessionPath: '/repo',
      ctx,
      proxy,
      connectionId: 'ssh-1',
    });

    await provider.spawnTerminal(terminal); // pty A, exit handler [0]
    await provider.rehydrate(); // discards A, spawns pty B, exit handler [1]

    const sessionId = makePtySessionId(terminal.locationId, terminal.sessionId, terminal.id);
    const sessions = (provider as unknown as { sessions: Map<string, unknown> }).sessions;
    const replacement = sessions.get(sessionId);
    expect(replacement).toBeDefined();

    // Fire the discarded pty A's late exit.
    ptyMock.exitHandlers[0]!({ exitCode: 0 });

    // The replacement session B is untouched.
    expect(sessions.get(sessionId)).toBe(replacement);
  });

  it('registers user terminals with their display name for resource monitor labels', async () => {
    const provider = new SshTerminalProvider({
      locationId: terminal.locationId,
      scopeId: terminal.sessionId,
      sessionPath: '/repo',
      ctx,
      proxy,
      connectionId: 'ssh-1',
    });

    await provider.spawnTerminal(terminal);

    const sessionId = makePtySessionId(terminal.locationId, terminal.sessionId, terminal.id);
    expect(ptySessionRegistry.register).toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
      expect.objectContaining({ metadata: { title: terminal.name, isRemote: true } })
    );
  });

  it('cleans up cached shell profiles after a non-respawned exit', async () => {
    const provider = new SshTerminalProvider({
      locationId: terminal.locationId,
      scopeId: terminal.sessionId,
      sessionPath: '/repo',
      ctx,
      proxy,
      connectionId: 'ssh-1',
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
});
