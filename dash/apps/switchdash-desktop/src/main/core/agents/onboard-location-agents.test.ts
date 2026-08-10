import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class GatewayError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  }
  const state: {
    /** Agent-row names already in the directory, per Switch server. */
    agentNamesByServer: Record<string, string[]>;
    definitions: Array<{
      name: string;
      description: string | null;
      eligible: boolean;
      registered: boolean;
    }>;
    /** On-disk credentials per definition name. */
    local: Array<{ name: string; switchAgentId: string | null; apiEndpoint: string | null }>;
    /** Switch agent ids the target server admits to having. */
    idsOnServer: string[];
  } = { agentNamesByServer: {}, definitions: [], local: [], idsOnServer: [] };
  return {
    state,
    GatewayError,
    warn: vi.fn(),
    createAgent: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: 'agent-row' })),
    agentExistsOnServer: vi.fn(async (_server: unknown, agentId: string) =>
      h.state.idsOnServer.includes(agentId)
    ),
    registerAgentIdentity: vi.fn(async () => ({
      kind: 'created' as const,
      id: 'sw-fresh',
      apiKey: 'tok-fresh',
    })),
    writeNeutralAgentSettings: vi.fn(async () => {}),
    openLocation: vi.fn(async () => {}),
    emit: vi.fn(),
  };
});

vi.mock('@main/core/locations/store', () => ({
  ensureLocation: vi.fn(async () => ({ id: 'loc-1' })),
}));
vi.mock('./getAgents', () => ({
  getLocationAgentsOnServer: vi.fn(async (_locationId: string, serverId: string) =>
    (h.state.agentNamesByServer[serverId] ?? []).map((name) => ({ name }))
  ),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({
    fs: {} as PluginFs,
    homeFs: {} as PluginFs,
    close: vi.fn(),
  })),
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({
    behavior: {
      repoAgents: {
        discoverDefinitions: async () => h.state.definitions,
        discoverLocal: async () => h.state.local,
      },
    },
  }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  agentExistsOnServer: h.agentExistsOnServer,
  GatewayError: h.GatewayError,
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: vi.fn(async () => ({
    id: 'srv-b',
    name: 'Server B',
    apiUrl: 'https://b.example.com',
  })),
  findServerByEndpoint: vi.fn(async (endpoint: string) =>
    endpoint === 'https://a.example.com'
      ? { id: 'srv-a', name: 'Server A', apiUrl: 'https://a.example.com' }
      : null
  ),
}));
vi.mock('./createAgent', () => ({ createAgent: h.createAgent }));
vi.mock('./register-agent-identity', () => ({ registerAgentIdentity: h.registerAgentIdentity }));
vi.mock('./write-switch-settings', () => ({
  writeNeutralAgentSettingsFs: h.writeNeutralAgentSettings,
}));
vi.mock('./known-agent-type', () => ({ knownAgentTypeForProvider: () => 'claude-code' }));
vi.mock('@main/core/locations/path-utils', () => ({ checkIsValidDirectory: () => true }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { openLocation: h.openLocation },
}));
vi.mock('./setAgentAutoSession', () => ({
  reconcileAgentAutoSessionFromGateway: vi.fn(async () => {}),
}));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: h.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: h.warn, error: vi.fn() } }));

const { onboardLocationAgents } = await import('./onboard-location-agents');

const onboard = (names: string[]) =>
  onboardLocationAgents({
    sshHost: null,
    dir: '/repo',
    providerId: 'claude',
    serverId: 'srv-b',
    names,
  });

function definition(name: string, registered: boolean) {
  return { name, description: null, eligible: true, registered };
}

describe('onboardLocationAgents identity resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.agentNamesByServer = {};
    h.state.definitions = [];
    h.state.local = [];
    h.state.idsOnServer = [];
  });

  it('refuses an identity registered with another server, and writes nothing (CHOO-2044)', async () => {
    // The credentials name server A. Server B does not have that id, and the
    // tempting fallback — mint a fresh identity — writes back over the same
    // credentials file, breaking the agent server A is still running.
    h.state.definitions = [definition('test-1', true)];
    h.state.local = [
      { name: 'test-1', switchAgentId: 'sw-on-a', apiEndpoint: 'https://a.example.com' },
    ];
    h.state.idsOnServer = [];

    const result = await onboard(['test-1']);

    expect(result.success).toBe(false);
    expect(h.registerAgentIdentity).not.toHaveBeenCalled();
    expect(h.writeNeutralAgentSettings).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it('names the owning server, not its URL, when switchdash has it registered', async () => {
    h.state.definitions = [definition('test-1', true)];
    h.state.local = [
      { name: 'test-1', switchAgentId: 'sw-on-a', apiEndpoint: 'https://a.example.com' },
    ];

    const result = await onboard(['test-1']);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatchObject({ type: 'error' });
    const message = 'message' in result.error ? result.error.message : '';
    expect(message).toContain('Server A');
    expect(message).toContain('Server B');
    expect(message).not.toContain('https://a.example.com');
  });

  it('says "another Switch server" rather than a URL for a server it does not know', async () => {
    h.state.definitions = [definition('test-1', true)];
    h.state.local = [
      { name: 'test-1', switchAgentId: 'sw-elsewhere', apiEndpoint: 'https://unknown.example.com' },
    ];

    const result = await onboard(['test-1']);

    expect(result.success).toBe(false);
    if (result.success) return;
    const message = 'message' in result.error ? result.error.message : '';
    expect(message).toContain('another Switch server');
    expect(message).not.toContain('https://unknown.example.com');
  });

  it('imports an identity the target server does have', async () => {
    h.state.definitions = [definition('mine', true)];
    h.state.local = [
      { name: 'mine', switchAgentId: 'sw-on-b', apiEndpoint: 'https://b.example.com' },
    ];
    h.state.idsOnServer = ['sw-on-b'];

    const result = await onboard(['mine']);

    expect(result.success).toBe(true);
    expect(h.registerAgentIdentity).not.toHaveBeenCalled();
    expect(h.writeNeutralAgentSettings).not.toHaveBeenCalled();
    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mine', switchAgentId: 'sw-on-b', serverId: 'srv-b' })
    );
  });

  it('still adopts a plain definition that carries no Switch identity', async () => {
    // The case adoption exists for: nothing on disk to overwrite, so minting is
    // the only way in and is safe.
    h.state.definitions = [definition('plain', false)];
    h.state.local = [{ name: 'plain', switchAgentId: null, apiEndpoint: null }];

    const result = await onboard(['plain']);

    expect(result.success).toBe(true);
    expect(h.registerAgentIdentity).toHaveBeenCalled();
    expect(h.writeNeutralAgentSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slug: 'plain', agentId: 'sw-fresh' })
    );
  });

  it('reports an unauthenticated server rather than minting past it', async () => {
    h.state.definitions = [definition('mine', true)];
    h.state.local = [
      { name: 'mine', switchAgentId: 'sw-on-b', apiEndpoint: 'https://b.example.com' },
    ];
    h.agentExistsOnServer.mockRejectedValueOnce(new h.GatewayError('unauthorized'));

    const result = await onboard(['mine']);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatchObject({ type: 'switch-server-unauthenticated' });
    expect(h.registerAgentIdentity).not.toHaveBeenCalled();
    expect(h.writeNeutralAgentSettings).not.toHaveBeenCalled();
  });

  it('offers a definition already onboarded onto another server', async () => {
    // Same directory, same name, different server — a separate agent.
    h.state.agentNamesByServer = { 'srv-a': ['shared'] };
    h.state.definitions = [definition('shared', false)];
    h.state.local = [{ name: 'shared', switchAgentId: null, apiEndpoint: null }];

    const result = await onboard(['shared']);

    expect(result.success).toBe(true);
    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shared', serverId: 'srv-b' })
    );
  });
});
