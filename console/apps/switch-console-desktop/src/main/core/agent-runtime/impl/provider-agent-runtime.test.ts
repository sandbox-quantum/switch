import type { ProviderSessionStartInput } from '@switch-console/agent-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionTranscriptChannel } from '@shared/core/sessions/session-transcript';
import type { Session } from '@shared/core/sessions/sessions';

const emit = vi.hoisted(() => vi.fn());
const startSession = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
/** Definition files the fake workspace claims to hold, keyed by relative path. */
const definitionFiles = vi.hoisted(() => new Set<string>());

// The same narrow stubs the smoke test uses: everything the module reaches for
// at import time that needs an app around it.
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: vi.fn() }));
vi.mock('@main/core/agents/agent-launch-config', () => ({ agentLaunchSpecialization: vi.fn() }));
vi.mock('@main/core/switch-rooms/switch-notification-poller', () => ({
  switchNotificationPoller: { ensureForSession: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { clearSession: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/provider-room-relay', () => ({
  providerRoomRelay: { onRequestOpened: vi.fn(), onRequestResolved: vi.fn(), unbind: vi.fn() },
}));
vi.mock('@main/core/sessions/operations/save-provider-session-id', () => ({
  saveNativeSessionId: vi.fn(),
}));
vi.mock('@main/core/sessions/session-hooks', () => ({ sessionHooks: { _emit: vi.fn() } }));
vi.mock('@main/core/agent-hooks/notification', () => ({
  isAppFocused: () => true,
  maybeShowNotification: vi.fn(),
}));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: vi.fn() },
}));
vi.mock('@main/core/agent-runtime/impl/provider-adapter-registry', () => ({
  providerAdapterRegistry: {
    get: () => ({ subscribe: () => () => {}, startSession, hasSession: () => true }),
  },
}));
vi.mock('@main/core/providers/plugin-fs', () => ({
  createPluginFs: () => ({ exists: async (path: string) => definitionFiles.has(path) }),
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: (providerId: string) => ({
    behavior: {
      // Only a provider with repo-agent definitions has one to launch as, which
      // is the difference the runtime branches on.
      repoAgents:
        providerId === 'claude'
          ? { definitionPath: (name: string) => `.claude/agents/${name}.md` }
          : undefined,
    },
  }),
}));
vi.mock('@main/core/switch-rooms/switch-credentials', () => ({
  readAgentSwitchEnvFromFs: async () => ({}),
}));
vi.mock('@main/core/pty/pty-env', () => ({ buildAgentEnv: () => ({}) }));

const { agentLaunchSpecialization } = await import('@main/core/agents/agent-launch-config');
const { ProviderAgentRuntime } = await import('./provider-agent-runtime');

function runtime(sessionId: string) {
  return new ProviderAgentRuntime({
    locationId: 'loc-1',
    sessionId,
    sessionPath: '/repo',
    sessionEnvVars: {},
  });
}

describe('ProviderAgentRuntime transcript updates', () => {
  it('emits them on the session topic the renderer subscribes to', () => {
    // The renderer's store listens per session (`session:transcript.<id>`), so
    // an untopic'd emit reaches nobody: the panel showed the snapshot it opened
    // with and never moved again, while the session ran to completion.
    runtime('session-1').notice('info', 'hello');

    expect(emit).toHaveBeenCalledTimes(1);
    const [channel, payload, topic] = emit.mock.calls[0] as [
      unknown,
      { sessionId: string },
      string,
    ];
    expect(channel).toBe(sessionTranscriptChannel);
    expect(payload.sessionId).toBe('session-1');
    expect(topic).toBe('session-1');
  });
});

describe('ProviderAgentRuntime session start input', () => {
  beforeEach(() => {
    startSession.mockClear();
    definitionFiles.clear();
  });

  function session(providerId: Session['providerId']): Session {
    return {
      id: 'session-2',
      agentId: 'agent-1',
      providerId,
      agentName: 'wanda',
      autoApprove: false,
    } as Session;
  }

  async function start(providerId: Session['providerId']): Promise<ProviderSessionStartInput> {
    await runtime('session-2').start(session(providerId));
    const [input] = startSession.mock.calls.at(0) ?? [];
    return input as unknown as ProviderSessionStartInput;
  }

  it('launches a Claude session as its own definition, the way `--agent` does', async () => {
    definitionFiles.add('.claude/agents/wanda.md');
    vi.mocked(agentLaunchSpecialization).mockResolvedValue(undefined);
    expect((await start('claude')).agentName).toBe('wanda');
  });

  it('names no definition when there is none on disk — Claude fails a session that does', async () => {
    vi.mocked(agentLaunchSpecialization).mockResolvedValue(undefined);
    expect((await start('claude')).agentName).toBeUndefined();
  });

  it("reads the reasoning control under each provider's own name", async () => {
    vi.mocked(agentLaunchSpecialization).mockResolvedValue({
      model: 'a-model',
      effort: 'low',
      variant: 'thinking',
    });
    expect((await start('claude')).model).toEqual({
      id: 'a-model',
      options: { effort: 'low' },
    });

    startSession.mockClear();
    expect((await start('opencode')).model).toEqual({
      id: 'a-model',
      options: { variant: 'thinking' },
    });
  });

  it('registers exactly one Switch MCP server, whatever the provider', async () => {
    vi.mocked(agentLaunchSpecialization).mockResolvedValue(undefined);
    for (const providerId of ['claude', 'opencode'] as const) {
      startSession.mockClear();
      expect(Object.keys((await start(providerId)).mcpServers)).toEqual(['switch']);
    }
  });
});
