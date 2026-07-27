import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pty, PtyExitInfo } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { agentSessionExitedChannel } from '@shared/core/providers/agentEvents';
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import type { Session } from '@shared/core/sessions/sessions';
import { SshAgentRuntime } from './ssh-agent-runtime';

const openSsh2Pty = vi.hoisted(() => vi.fn());
const buildCommandMock = vi.hoisted(() =>
  vi.fn((_ctx: Record<string, unknown>) => ({
    command: 'agent',
    args: [] as string[],
    env: {} as Record<string, string>,
  }))
);
const resolveSshCommand = vi.hoisted(() => vi.fn(() => 'remote-cmd'));
const deployAndLaunch = vi.hoisted(() => vi.fn(async () => ({ port: 9999, token: 'sidecar-tok' })));
const sidecarStop = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./resolve-sidecar-bundle', () => ({
  resolveSidecarBundlePath: vi.fn(() => '/local/dist-sidecar/sidecar.mjs'),
}));

vi.mock('@main/core/agents/reap-stale-sidecars', () => ({
  reapStaleSidecarsForAgent: vi.fn(async () => {}),
}));

vi.mock('./remote-sidecar-launcher', () => ({
  RemoteSidecarLauncher: vi.fn(function () {
    return { deployAndLaunch, stop: sidecarStop };
  }),
  reapOrphanedSidecars: vi.fn(async () => {}),
  agentSidecarTmuxName: vi.fn(() => 'switchdash-sidecar-test'),
}));

const httpPostJsonOverChannel = vi.hoisted(() => vi.fn(async () => {}));

// POST is spied so disconnect can be asserted; GET is parked so the hook-event
// relay's poll loop doesn't spin in tests that don't exercise relaying.
vi.mock('./sidecar-http', () => ({
  httpPostJsonOverChannel,
  httpGetJsonOverChannel: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@main/core/pty/ssh2-pty', () => ({ openSsh2Pty }));

vi.mock('@main/core/pty/spawn-utils', () => ({ resolveSshCommand }));

vi.mock('@main/core/pty/terminal-color-scheme', () => ({
  getTerminalColorEnv: vi.fn(async () => ({})),
}));

vi.mock('@main/core/dependencies/host-dependency-store', () => ({
  hostDependencyStore: {
    getSelection: vi.fn().mockResolvedValue(null),
    setSelection: vi.fn().mockResolvedValue(undefined),
  },
}));

// Stubbed so importing the runtime doesn't pull in the DB client (no Electron
// `app` in tests). launchSidecar reads the agent's autoApprove for the spec.
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: vi.fn(async () => ({ autoApprove: false })),
}));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: vi.fn((id: string) => ({
    metadata: { id },
    capabilities: { hostDependency: { binaryNames: [id] }, hooks: { kind: 'none' } },
    behavior: { prompt: { buildCommand: buildCommandMock } },
  })),
}));

vi.mock('./keystroke-injection', () => ({
  scheduleInitialPromptInjection: vi.fn(),
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));

vi.mock('@main/core/settings/provider-settings-service', () => ({
  providerOverrideSettings: { getItem: vi.fn(async () => undefined) },
}));

vi.mock('./resolve-agent-executable', () => ({
  resolveAgentExecutable: vi.fn(async ({ binaryName }: { binaryName: string }) => binaryName),
  clearResolvedPathCache: vi.fn(),
}));

const handleRawHook = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { handleRawHook },
}));

const connectionListeners = vi.hoisted(
  () => [] as Array<(evt: { type: string; connectionId: string }) => void>
);

vi.mock('@main/core/ssh/lifecycle/production-ssh-connection-manager', () => ({
  sshConnectionManager: {
    on: vi.fn((_event: string, cb: (evt: { type: string; connectionId: string }) => void) => {
      connectionListeners.push(cb);
    }),
    off: vi.fn((_event: string, cb: (evt: { type: string; connectionId: string }) => void) => {
      const idx = connectionListeners.indexOf(cb);
      if (idx >= 0) connectionListeners.splice(idx, 1);
    }),
  },
}));

function emitReconnected(connectionId: string): void {
  for (const cb of [...connectionListeners]) cb({ type: 'reconnected', connectionId });
}

const { events } = await import('@main/lib/events');

type ProviderState = {
  known: boolean;
  pty: Pty | null;
};

function makeProxy(overrides: Partial<SshClientProxy> = {}): SshClientProxy {
  return {
    connectionId: 'ssh-1',
    getRemoteShellProfile: vi.fn(async () => ({ shell: '/bin/bash', env: {} })),
    refreshRemoteShellProfile: vi.fn(async () => ({ shell: '/bin/bash', env: {} })),
    // Never resolves: parks the hook-event relay's poll loop so it does not spin
    // in tests that don't exercise event relaying.
    forwardOut: vi.fn(() => new Promise<never>(() => {})),
    ...overrides,
  } as unknown as SshClientProxy;
}

function makeCtx(): ConstructorParameters<typeof SshAgentRuntime>[0]['ctx'] {
  return { exec: vi.fn(async () => ({ stdout: '', stderr: '' })) } as never;
}

function sshProvider({
  proxy = makeProxy(),
  tmux = false,
  ctx = makeCtx(),
}: {
  proxy?: SshClientProxy;
  tmux?: boolean;
  ctx?: ConstructorParameters<typeof SshAgentRuntime>[0]['ctx'];
} = {}) {
  return new SshAgentRuntime({
    locationId: 'location-1',
    sessionId: 'session-1',
    sessionPath: '/repo',
    tmux,
    ctx,
    fs: { copyLocalFile: vi.fn(async () => {}) } as never,
    proxy,
    connectionId: 'ssh-1',
  });
}

function session(): Session {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id: 'session-1',
    agentId: 'agent-1',
    providerId: 'codex',
    title: 'Session 1',
    shellId: 'system',
    status: 'in_progress',
    statusChangedAt: now,
    agentSessionId: null,
    providerSessionId: 'provider-session-1',
    isInitialSession: false,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

function fakePty(exitHandlers: Array<(info: PtyExitInfo) => void>): Pty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler) => exitHandlers.push(handler)),
  } as unknown as Pty;
}

function mockSpawn(exitHandlers: Array<Array<(info: PtyExitInfo) => void>>): void {
  openSsh2Pty.mockImplementation(async () => {
    const handlers: Array<(info: PtyExitInfo) => void> = [];
    exitHandlers.push(handlers);
    return { success: true, data: fakePty(handlers) };
  });
}

describe('SshAgentRuntime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    openSsh2Pty.mockReset();
    buildCommandMock.mockReset();
    buildCommandMock.mockReturnValue({ command: 'agent', args: [], env: {} });
    resolveSshCommand.mockClear();
    deployAndLaunch.mockClear();
    sidecarStop.mockClear();
    httpPostJsonOverChannel.mockClear();
    vi.mocked(events.emit).mockClear();
    connectionListeners.length = 0;
    ptySessionRegistry.unregister('location-1:session-1');
  });

  it('spawns the agent over SSH and registers a remote pty', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();
    const sessionId = makeAgentPtySessionId('location-1', item.id);

    await sshProvider().start(item);

    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    expect(resolveSshCommand).toHaveBeenCalledWith(
      'agent',
      expect.objectContaining({ cwd: '/repo', sessionId: 'session-1' }),
      expect.anything(),
      expect.anything()
    );
    expect(ptySessionRegistry.get(sessionId)).toBeDefined();
  });

  it('propagates a failed SSH channel open as an error', async () => {
    openSsh2Pty.mockResolvedValue({ success: false, error: new Error('channel refused') });

    await expect(sshProvider().start(session())).rejects.toThrow('channel refused');
  });

  it('restarts a resumed session fresh after it exits', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      mockSpawn(exitHandlers);
      const item = session();

      await sshProvider().start(item, { cols: 80, rows: 24 }, true, 'continue');
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(openSsh2Pty).toHaveBeenCalledTimes(2);
      expect(buildCommandMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ isResuming: false })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the remote shell profile and retries once on exit 127', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      mockSpawn(exitHandlers);
      const proxy = makeProxy();
      const item = session();

      await sshProvider({ proxy }).start(item);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 127 });
      await vi.advanceTimersByTimeAsync(500);

      expect(proxy.refreshRemoteShellProfile).toHaveBeenCalledTimes(1);
      expect(openSsh2Pty).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a delayed replacement after explicit stop', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      mockSpawn(exitHandlers);
      const provider = sshProvider();
      const item = session();

      await provider.start(item);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await provider.stop();
      await vi.advanceTimersByTimeAsync(500);

      expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits session-exited on a non-stopped exit', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider();
    const item = session();

    await provider.start(item);
    vi.mocked(events.emit).mockClear();
    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });

    expect(events.emit).toHaveBeenCalledWith(
      agentSessionExitedChannel,
      expect.objectContaining({ sessionId: item.id })
    );
  });

  it('launches the sidecar and points the agent hook env at it when tmux is on', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();

    await sshProvider({ tmux: true }).start(item);

    expect(deployAndLaunch).toHaveBeenCalledTimes(1);
    const env = (resolveSshCommand.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(env.SWITCHDASH_HOOK_PORT).toBe('9999');
    expect(env.SWITCHDASH_HOOK_TOKEN).toBe('sidecar-tok');
    expect(env.SWITCH_CHANNEL_DISABLE_POLL).toBe('1');
  });

  it('starts the hook-event relay against the sidecar endpoint when tmux is on', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const proxy = makeProxy();
    const item = session();

    await sshProvider({ proxy, tmux: true }).start(item);
    await vi.waitFor(() => expect(proxy.forwardOut).toHaveBeenCalledWith(9999));
  });

  it('leaves the shared sidecar running when a single session is stopped', async () => {
    // The sidecar is agent-scoped and shared (other sessions + its notification
    // watcher rely on it), so stopping one session must not kill it — only its
    // own tmux pane and hook-event relay are torn down.
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const proxy = makeProxy({ forwardOut: vi.fn(async () => ({ destroy: vi.fn() }) as never) });
    const provider = sshProvider({ proxy, tmux: true });
    const item = session();

    await provider.start(item);
    await provider.stop();

    expect(sidecarStop).not.toHaveBeenCalled();
  });

  it('POSTs /disconnect to the sidecar on stopSession when tmux is on', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const proxy = makeProxy({ forwardOut: vi.fn(async () => ({ destroy: vi.fn() }) as never) });
    const provider = sshProvider({ proxy, tmux: true });
    const item = session();

    await provider.start(item);
    await provider.stop();

    expect(httpPostJsonOverChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: '/disconnect',
        body: { sessionId: item.id, terminated: true },
      })
    );
  });

  it('does not disconnect the sidecar for a local (non-tmux) session', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider({ tmux: false });
    const item = session();

    await provider.start(item);
    await provider.stop();

    expect(httpPostJsonOverChannel).not.toHaveBeenCalled();
  });

  it('re-attaches a remote tmux session on reconnect without relaunching the sidecar', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();

    await sshProvider({ tmux: true }).start(item);
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
    expect(deployAndLaunch).toHaveBeenCalledTimes(1);

    // The interactive PTY dies with the dropped connection; for tmux the
    // provider tears down the local session but leaves it desired.
    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });

    emitReconnected('ssh-1');
    await vi.waitFor(() => expect(openSsh2Pty).toHaveBeenCalledTimes(2));
    // Re-attach reuses the still-running sidecar + relay rather than relaunching.
    expect(deployAndLaunch).toHaveBeenCalledTimes(1);
  });

  it('ignores reconnect events for other connections', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const item = session();

    await sshProvider({ tmux: true }).start(item);
    for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });

    emitReconnected('ssh-OTHER');
    await new Promise((r) => setTimeout(r, 20));
    expect(openSsh2Pty).toHaveBeenCalledTimes(1);
  });

  it('forgets the session and kills the pty on stop', async () => {
    const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
    mockSpawn(exitHandlers);
    const provider = sshProvider();
    const item = session();

    await provider.start(item);
    const pty = (provider as unknown as ProviderState).pty!;
    await provider.stop();

    expect(pty.kill).toHaveBeenCalled();
    expect((provider as unknown as ProviderState).known).toBe(false);
  });
});
