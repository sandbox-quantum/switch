import { pluginRegistry } from '@switch-console/plugins/agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_FRESH_RECOVERY_GRACE_MS } from '@main/core/agent-runtime/agent-runtime-supervisor';
import { getAgentById } from '@main/core/agents/getAgentById';
import type { Pty, PtyExitInfo } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { agentSessionExitedChannel } from '@shared/core/providers/agentEvents';
import { ptyExitChannel } from '@shared/core/pty/ptyEvents';
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import type { Session } from '@shared/core/sessions/sessions';
import { SWITCH_RUNTIME_REQUIRED_ENV } from '@shared/core/switch-rooms/switch-agent-runtime';
import { LocalAgentRuntime } from './local-agent-runtime';

const spawnLocalPty = vi.hoisted(() => vi.fn());
const buildCommandMock = vi.hoisted(() =>
  vi.fn((_ctx: Record<string, unknown>) => ({
    command: 'agent',
    args: [] as string[],
    env: {} as Record<string, string>,
  }))
);
const installPluginMock = vi.hoisted(() => vi.fn(async () => []));
const writeHooksMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('@main/core/dependencies/host-dependency-store', () => ({
  hostDependencyStore: {
    getSelection: vi.fn().mockResolvedValue(null),
    setSelection: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: {
    getPort: vi.fn(() => 0),
    getToken: vi.fn(() => 'token'),
  },
}));

vi.mock('@main/core/agent-hooks/dir-trust-service', () => ({
  dirTrustService: {
    maybeAutoTrustLocal: vi.fn(),
  },
}));

// Avoid pulling the real Switch room service / notification poller (and their
// db/client import) into the node test environment, where better-sqlite3 is
// electron-compiled.
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: {
    restoreConnection: vi.fn(() => Promise.resolve()),
    clearSession: vi.fn(),
  },
}));

vi.mock('@main/core/switch-rooms/switch-notification-poller', () => ({
  switchNotificationPoller: {
    disconnect: vi.fn(),
    // Sessions in these tests are not Switch agents, so no connection is
    // opened and no SWITCH_CONNECTION_ID reaches the spawn.
    ensureForSession: vi.fn(async () => null),
  },
}));

vi.mock('@main/core/switch-rooms/switch-credentials', () => ({
  readAgentSwitchEnvFromFs: vi.fn(async () => ({})),
}));

// Loading the agent record to fold in per-agent Codex config would pull in the
// DB client, which has no database in this unit test.
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: vi.fn(async () => null),
}));

// Reads the app's userData path and shells out to `gh`; neither exists here,
// and these tests are about the spawn, not the registry.
vi.mock('@main/core/switch-rooms/npm-registry-auth', () => ({
  npmRegistryAuthEnv: vi.fn(async () => ({})),
}));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: vi.fn((id: string) => ({
    metadata: { id },
    capabilities: {
      hostDependency: { binaryNames: [id] },
      hooks:
        id === 'opencode'
          ? { kind: 'plugin', scope: 'workspace', supportedEvents: [] }
          : { kind: 'none' },
      prompt: { kind: 'argv', flag: '' },
    },
    behavior: {
      prompt: { buildCommand: buildCommandMock },
      hooks: {
        writeHooks: writeHooksMock,
        deleteHooks: vi.fn(),
        readHooks: vi.fn(),
        getHooksInstalled: vi.fn(),
      },
      plugins: {
        installPlugin: installPluginMock,
        uninstallPlugin: vi.fn(),
        isPluginInstalled: vi.fn(),
        getPluginVersion: vi.fn(),
        getPluginPath: vi.fn(),
      },
      // The real builder, not a stand-in: these tests exist to check what the
      // profile actually tells Codex, which a fake profile cannot show.
      mcp:
        id === 'codex'
          ? (pluginRegistry.get('codex')!.behavior as { mcp?: unknown }).mcp
          : undefined,
    },
  })),
}));

// Keyed by root because the runtime opens two: the workspace (creds) and the
// home dir (the Codex profile). A single shared fake cannot tell them apart.
vi.mock('@main/core/providers/plugin-fs', () => ({
  createPluginFs: vi.fn((root: string) => pluginFsFor(root)),
}));

vi.mock('@main/core/pty/local-pty', () => ({
  spawnLocalPty,
}));

vi.mock('./keystroke-injection', () => ({
  scheduleInitialPromptInjection: vi.fn(),
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('@main/core/settings/provider-settings-service', () => ({
  providerOverrideSettings: {
    getItem: vi.fn(async () => undefined),
  },
}));

vi.mock('@main/core/dependencies/dependency-managers', () => ({
  localDependencyManager: {
    get: vi.fn(() => undefined),
  },
  getDependencyManager: vi.fn(async () => ({
    get: vi.fn(() => undefined),
  })),
}));

vi.mock('./resolve-agent-executable', () => ({
  resolveAgentExecutable: vi.fn(async ({ binaryName }: { binaryName: string }) => binaryName),
  clearResolvedPathCache: vi.fn(),
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: {
    get: vi.fn(async (key: string) =>
      key === 'terminal'
        ? {
            autoCopyOnSelection: false,
            macOptionIsMeta: false,
            defaultShell: 'system',
            fontSize: 13,
          }
        : {
            defaultLocationsDirectory: '',
            defaultWorktreeDirectory: '',
            writeAgentConfigToGitIgnore: true,
          }
    ),
  },
}));

const { events } = await import('@main/lib/events');
const { readAgentSwitchEnvFromFs } = await import('@main/core/switch-rooms/switch-credentials');
const { agentHookService } = await import('@main/core/agent-hooks/agent-hook-service');
const { appSettingsService } = await import('@main/core/settings/settings-service');

type RespawnState = {
  known: boolean;
  pty: Pty | null;
};

function localProvider({
  tmux = false,
  shellProfile = {
    id: 'sh',
    resolvedShellId: 'sh',
    resolvedFromSystem: true,
    executable: 'sh',
    available: true,
    family: 'posix',
    interactiveArgs: ['-i'],
    commandArgs: ['-c'],
  },
  ctx = {} as never,
}: {
  tmux?: boolean;
  shellProfile?: ConstructorParameters<typeof LocalAgentRuntime>[0]['shellProfile'];
  ctx?: ConstructorParameters<typeof LocalAgentRuntime>[0]['ctx'];
} = {}) {
  return new LocalAgentRuntime({
    locationId: 'location-1',
    sessionId: 'session-1',
    sessionPath: '/tmp/session-1',
    tmux,
    shellProfile,
    ctx,
  });
}

function session(): Session {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id: 'session-1',
    agentId: 'agent-1',
    agentName: 'codex-hoot',
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

/** One in-memory PluginFs per root, so a test can read what was written where. */
const pluginFsRoots = new Map<string, Map<string, string>>();

function pluginFsFor(root: string) {
  const files = pluginFsRoots.get(root) ?? new Map<string, string>();
  pluginFsRoots.set(root, files);
  return {
    read: vi.fn(async (p: string) => files.get(p) ?? null),
    write: vi.fn(async (p: string, content: string) => {
      files.set(p, content);
    }),
    delete: vi.fn(async (p: string) => {
      files.delete(p);
    }),
    exists: vi.fn(async (p: string) => files.has(p)),
    list: vi.fn(async () => []),
  };
}

/** The Codex profile written to the agent's home, whichever root that was. */
function writtenCodexProfile(): string {
  for (const files of pluginFsRoots.values()) {
    for (const [path, content] of files) {
      if (path.endsWith('.config.toml')) return content;
    }
  }
  throw new Error('no Codex profile was written');
}

function fakePty(exitHandlers: Array<(info: PtyExitInfo) => void>): Pty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler) => exitHandlers.push(handler)),
  };
}

function mockSettings(): void {
  vi.mocked(appSettingsService.get).mockImplementation(async (key) => {
    if (key === 'localLocation') {
      return {
        defaultLocationsDirectory: '',
        defaultWorktreeDirectory: '',
        writeAgentConfigToGitIgnore: true,
      } as never;
    }
    throw new Error(`Unexpected settings key: ${key}`);
  });
}

describe('local agent runtime respawn state', () => {
  beforeEach(() => {
    vi.useRealTimers();
    spawnLocalPty.mockReset();
    buildCommandMock.mockReset();
    buildCommandMock.mockReturnValue({ command: 'agent', args: [], env: {} });
    installPluginMock.mockReset();
    installPluginMock.mockResolvedValue([]);
    writeHooksMock.mockReset();
    writeHooksMock.mockResolvedValue([]);
    mockSettings();
    vi.mocked(events.emit).mockClear();
    vi.mocked(agentHookService.getPort).mockReturnValue(0);
    vi.mocked(agentHookService.getToken).mockReturnValue('token');
    ptySessionRegistry.unregister('location-1:session-1');
    pluginFsRoots.clear();
  });

  it('writes the Codex profile to the home dir and loads it on argv', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    vi.mocked(getAgentById).mockResolvedValueOnce({
      providerConfig: { version: '2', providerId: 'codex', values: { model: 'gpt-5.6-terra' } },
    } as unknown as Awaited<ReturnType<typeof getAgentById>>);
    vi.mocked(readAgentSwitchEnvFromFs).mockResolvedValueOnce({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'sw-1',
    });

    await localProvider().start(session());

    expect(writtenCodexProfile()).toContain('model = "gpt-5.6-terra"');
    // The Switch server comes from the connector plugin's own `.mcp.json`; the
    // profile carries only what is per-agent.
    expect(writtenCodexProfile()).not.toContain('mcp_servers');
    // Profile name is digest-suffixed on (dir, slug) so same-named agents in
    // different dirs don't collide.
    expect(buildCommandMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentArgs: ['--profile', expect.stringMatching(/^codex-hoot-[a-z0-9]+$/)],
      })
    );
  });

  it('writes no profile at all for a Codex agent that specializes nothing', async () => {
    // The profile used to exist for the MCP registration, so every Codex agent
    // got one. Now an agent on the defaults has nothing to put in it, and an
    // empty file would still add a `--profile` pointing at nothing.
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));

    await localProvider().start(session());

    expect(() => writtenCodexProfile()).toThrow(/no Codex profile/);
    expect(buildCommandMock).toHaveBeenLastCalledWith(expect.objectContaining({ agentArgs: [] }));
  });

  it('puts the runtime credentials onto the session it spawns', async () => {
    // Codex forwards these by name out of its own environment into the MCP
    // server, so a name the connector's `.mcp.json` lists but the session lacks
    // reaches the runtime as nothing at all — and a missing credential kills the
    // handshake, not just one tool. Asserted against the runtime's own contract
    // rather than the profile, which no longer declares the server.
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    vi.mocked(readAgentSwitchEnvFromFs).mockResolvedValueOnce({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'sw-1',
    });

    await localProvider().start(session());

    const spawned = (spawnLocalPty.mock.calls[0][0] as { env: Record<string, string> }).env;

    // SWITCH_CONNECTION_ID and the npm settings come from services stubbed out
    // here; the credentials are the ones this path is responsible for.
    for (const name of SWITCH_RUNTIME_REQUIRED_ENV) {
      expect(spawned).toHaveProperty(name);
    }
  });

  it('reads the identity file keyed by the agent row name, not the session id', async () => {
    // Every writer keys `.switch/agents/<slug>.json` by the agent's name; a
    // reader that keyed by id would silently fall back to the shared
    // settings.local.json identity (CHOO-1440).
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    vi.mocked(readAgentSwitchEnvFromFs).mockResolvedValueOnce({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'sw-1',
    });

    await localProvider().start(session());

    expect(readAgentSwitchEnvFromFs).toHaveBeenCalledWith(
      expect.anything(),
      'codex-hoot',
      expect.anything()
    );
    const request = spawnLocalPty.mock.calls[0][0] as { env: Record<string, string> };
    expect(request.env.SWITCH_API_TOKEN).toBe('tok-123');
    expect(request.env.SWITCH_AGENT_ID).toBe('sw-1');
  });

  it('passes global editor variables to local agent sessions', async () => {
    const previousEditor = process.env.EDITOR;
    const previousShell = process.env.SHELL;
    try {
      process.env.EDITOR = 'zed';
      process.env.SHELL = '/bin/zsh';
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));

      await localProvider().start(session());

      const request = spawnLocalPty.mock.calls[0][0] as { env: Record<string, string> };
      expect(request.env.EDITOR).toBe('zed');
      expect(request.env.SHELL).toBe('sh');
    } finally {
      if (previousEditor === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = previousEditor;
      }
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }
  });

  it('uses the injected shell profile for local agent sessions', async () => {
    const shellProfile: ConstructorParameters<typeof LocalAgentRuntime>[0]['shellProfile'] = {
      id: 'bash',
      resolvedShellId: 'bash',
      resolvedFromSystem: false,
      executable: 'bash',
      available: true,
      family: 'posix',
      interactiveArgs: ['-il'],
      commandArgs: ['-lc'],
    };
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));

    await localProvider({ shellProfile }).start(session());

    expect(spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'bash',
        args: ['-lc', 'agent'],
      })
    );
  });

  it('sets SHELL to the injected POSIX shell for local agent sessions', async () => {
    const shellProfile: ConstructorParameters<typeof LocalAgentRuntime>[0]['shellProfile'] = {
      id: 'bash',
      resolvedShellId: 'bash',
      resolvedFromSystem: false,
      executable: '/bin/bash',
      available: true,
      family: 'posix',
      interactiveArgs: ['-il'],
      commandArgs: ['-lc'],
    };
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));

    await localProvider({ shellProfile }).start(session());

    expect(spawnLocalPty).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ SHELL: '/bin/bash' }),
      })
    );
  });

  it('prepares OpenCode hooks when hook config is available', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const item = { ...session(), providerId: 'opencode' as const };

    await localProvider().start(item);

    expect(installPluginMock).toHaveBeenCalledWith(expect.anything(), {
      kind: 'workspace',
      path: '/tmp/session-1',
    });
  });

  it('starts a local agent fresh after a resumed session exits', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const size = { cols: 100, rows: 40 };
      const initialPrompt = 'continue';
      const item = session();

      await provider.start(item, size, true, initialPrompt);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenCalledTimes(2);
      expect(buildCommandMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ isResuming: false })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops local recovery when a fresh fallback exits before the startup grace period', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const item = session();

      await provider.start(item, undefined, true);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);
      for (const handler of exitHandlers[1] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenCalledTimes(2);
      expect(events.emit).toHaveBeenCalledWith(
        agentSessionExitedChannel,
        expect.objectContaining({ sessionId: item.id })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a new local recovery cycle after fresh fallback survives the startup grace period', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const item = session();

      await provider.start(item, undefined, true);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(AGENT_FRESH_RECOVERY_GRACE_MS);
      for (const handler of exitHandlers[1] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenCalledTimes(3);
      expect(buildCommandMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ isResuming: true })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits PTY exit when a local agent unregisters before the registry exit handler runs', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const exitInfo = { exitCode: 0 };
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const provider = localProvider();
    const item = session();
    const sessionId = makeAgentPtySessionId('location-1', item.id);

    await provider.start(item);
    vi.mocked(events.emit).mockClear();
    for (const handler of exitHandlers) handler(exitInfo);

    expect(events.emit).toHaveBeenCalledWith(ptyExitChannel, exitInfo, sessionId);
  });

  it('uses the last observed terminal size when replacing a local agent', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const item = session();
      const sessionId = makeAgentPtySessionId('location-1', item.id);

      await provider.start(item, { cols: 100, rows: 40 }, true);
      ptySessionRegistry.resize(sessionId, 68, 42);
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cols: 68, rows: 42 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a local agent fresh after one resume replacement exits', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const item = session();

      await provider.start(item);

      for (let index = 0; index < 2; index += 1) {
        for (const handler of exitHandlers[index] ?? []) handler({ exitCode: 1 });
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(spawnLocalPty).toHaveBeenCalledTimes(3);
      expect(buildCommandMock.mock.calls.map(([args]) => args.isResuming)).toEqual([
        false,
        true,
        false,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not loop when local replacement spawn fails', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValueOnce(fakePty(exitHandlers)).mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });
      const provider = localProvider();
      const item = session();

      await provider.start(item);
      for (const handler of exitHandlers) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a delayed local replacement after explicit stop', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const provider = localProvider();
      const item = session();

      await provider.start(item);
      for (const handler of exitHandlers) handler({ exitCode: 0 });
      await provider.stop();
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replace a local tmux attachment after it exits', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const provider = localProvider({ tmux: true });
      const item = session();

      await provider.start(item);
      vi.mocked(events.emit).mockClear();
      for (const handler of exitHandlers) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnLocalPty).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        agentSessionExitedChannel,
        expect.objectContaining({ sessionId: item.id })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches local tmux agents without killing the tmux session', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const pty = fakePty(exitHandlers);
    spawnLocalPty.mockReturnValue(pty);
    const ctx = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };
    const provider = localProvider({ tmux: true, ctx: ctx as never });
    const item = session();

    await provider.start(item);
    vi.mocked(events.emit).mockClear();
    await provider.dehydrate();
    for (const handler of exitHandlers) handler({ exitCode: 0 });

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(ctx.exec).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith(agentSessionExitedChannel, expect.anything());
    expect((provider as unknown as RespawnState).known).toBe(true);
  });

  it('kills tmux when explicitly stopping a detached local agent', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const ctx = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };
    const provider = localProvider({ tmux: true, ctx: ctx as never });
    const item = session();

    await provider.start(item);
    await provider.dehydrate();
    await provider.stop();

    expect(ctx.exec).toHaveBeenCalledWith('tmux', [
      'kill-session',
      '-t',
      expect.stringContaining(Buffer.from(`session-${item.id}`, 'utf8').toString('base64url')),
    ]);
    expect((provider as unknown as RespawnState).known).toBe(false);
  });

  it('ignores stale local attach exits after a tmux agent is rehydrated', async () => {
    const firstExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const secondExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const firstPty = fakePty(firstExitHandlers);
    const secondPty = fakePty(secondExitHandlers);
    spawnLocalPty.mockReturnValueOnce(firstPty).mockReturnValueOnce(secondPty);
    const provider = localProvider({ tmux: true });
    const item = session();

    await provider.start(item);
    await provider.dehydrate();
    await provider.start(item);
    vi.mocked(events.emit).mockClear();
    for (const handler of firstExitHandlers) handler({ exitCode: 0 });

    expect((provider as unknown as RespawnState).pty).toBe(secondPty);
    expect(events.emit).not.toHaveBeenCalledWith(agentSessionExitedChannel, expect.anything());
  });
});
