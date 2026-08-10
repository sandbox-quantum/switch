import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A {@link PluginFs} that fails any write. Attaching adopts another install's
 * directory, so every write is a bug — this turns "should not write" into a
 * test failure at the point of the write rather than an assertion after it.
 */
function readOnlyFs(seed: Record<string, string>): PluginFs {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    read: (p) => Promise.resolve(files.get(p) ?? null),
    write: (p) => Promise.reject(new Error(`attach wrote to the workspace: ${p}`)),
    delete: (p) => Promise.reject(new Error(`attach deleted from the workspace: ${p}`)),
    exists: (p) => Promise.resolve(files.has(p)),
    list: (dir) => {
      const prefix = `${dir}/`;
      const entries = new Set<string>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        entries.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return Promise.resolve([...entries]);
    },
  };
}

function creds(agentId: string, endpoint = 'https://switch.example.com') {
  return JSON.stringify({
    env: {
      SWITCH_API_ENDPOINT: endpoint,
      SWITCH_API_TOKEN: 'tok-secret',
      SWITCH_AGENT_ID: agentId,
    },
  });
}

const h = vi.hoisted(() => {
  class GatewayError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  }
  const state: {
    workspace: PluginFs | null;
    /** Agent-row names already in the directory, per Switch server. */
    agentNamesByServer: Record<string, string[]>;
    existsOnServer: boolean;
    existsThrows: Error | null;
  } = { workspace: null, agentNamesByServer: {}, existsOnServer: true, existsThrows: null };
  return {
    state,
    GatewayError,
    warn: vi.fn(),
    createAgent: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
    agentExistsOnServer: vi.fn(async () => {
      if (h.state.existsThrows) throw h.state.existsThrows;
      return h.state.existsOnServer;
    }),
    openLocation: vi.fn(async () => {}),
    emit: vi.fn(),
  };
});

vi.mock('@main/core/locations/store', () => ({
  getLocationByHostDir: vi.fn(async () => ({ id: 'loc-1' })),
  ensureLocation: vi.fn(async () => ({ id: 'loc-1' })),
}));
vi.mock('./getAgents', () => ({
  getLocationAgentsOnServer: vi.fn(async (_locationId: string, serverId: string) =>
    (h.state.agentNamesByServer[serverId] ?? []).map((name) => ({ name }))
  ),
}));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({
    fs: h.state.workspace as PluginFs,
    homeFs: null,
    close: vi.fn(),
  })),
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  listPlugins: () => [{ metadata: { id: 'codex' }, behavior: {} }],
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  agentExistsOnServer: h.agentExistsOnServer,
  GatewayError: h.GatewayError,
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: vi.fn(async () => ({
    id: 'srv-1',
    name: 'Switch',
    apiUrl: 'https://switch.example.com',
  })),
}));
vi.mock('./createAgent', () => ({ createAgent: h.createAgent }));
vi.mock('@main/core/locations/path-utils', () => ({ checkIsValidDirectory: () => true }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { openLocation: h.openLocation },
}));
vi.mock('./setAgentAutoSession', () => ({
  reconcileAgentAutoSessionFromGateway: vi.fn(async () => {}),
}));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: h.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: h.warn, error: vi.fn() } }));

const { attachConfiguredAgents } = await import('./attach-configured-agents');

function params(agents: Array<{ name: string; providerId: 'codex' | 'claude' }>) {
  return { sshHost: 'vm-1', dir: '/repo', serverId: 'srv-1', agents };
}

describe('attachConfiguredAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.agentNamesByServer = {};
    h.state.existsOnServer = true;
    h.state.existsThrows = null;
    h.state.workspace = readOnlyFs({ '.switch/agents/theirs.json': creds('sw-theirs') });
  });

  it('adopts the existing Switch identity instead of minting a new one', async () => {
    const result = await attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]));

    expect(result.success).toBe(true);
    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'theirs',
        providerId: 'codex',
        switchAgentId: 'sw-theirs',
        apiEndpoint: 'https://switch.example.com',
        locationId: 'loc-1',
      })
    );
  });

  it('writes nothing to the working directory', async () => {
    // The workspace belongs to whichever install set the agent up. Any write
    // here rejects, so this passing means attach touched none of their state.
    await expect(
      attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]))
    ).resolves.toMatchObject({ success: true });
  });

  it('fails loudly when the identity no longer exists on the server', async () => {
    // Minting a replacement here would create exactly the duplicate agent this
    // feature exists to avoid.
    h.state.existsOnServer = false;

    const result = await attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]));

    expect(result).toMatchObject({
      success: false,
      error: { type: 'switch-agent-not-on-server', agentId: 'sw-theirs' },
    });
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it('reports an unauthenticated server rather than throwing', async () => {
    h.state.existsThrows = new h.GatewayError('unauthorized');

    expect(
      await attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]))
    ).toMatchObject({ success: false, error: { type: 'switch-server-unauthenticated' } });
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it('refuses a name that is no longer configured in the directory', async () => {
    const result = await attachConfiguredAgents(params([{ name: 'ghost', providerId: 'codex' }]));

    expect(result.success).toBe(false);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it('skips an agent this switchdash already has', async () => {
    h.state.agentNamesByServer = { 'srv-1': ['theirs'] };

    const result = await attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]));

    expect(result.success).toBe(false);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it('attaches an agent already attached to a different server (CHOO-2044)', async () => {
    // Same directory, same name, other server — a separate agent, not a duplicate.
    h.state.agentNamesByServer = { 'srv-other': ['theirs'] };

    const result = await attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]));

    expect(result.success).toBe(true);
    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'theirs', serverId: 'srv-1' })
    );
  });

  it('keeps the directory endpoint and warns when it differs from the chosen server', async () => {
    // One Switch server can be reachable at two URLs. The launch path reads the
    // endpoint from the same file as the token, so the directory's value is what
    // the session will really use — surfaced, never corrected.
    h.state.workspace = readOnlyFs({
      '.switch/agents/theirs.json': creds('sw-theirs', 'https://switch.internal:8443'),
    });

    await attachConfiguredAgents(params([{ name: 'theirs', providerId: 'codex' }]));

    expect(h.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ apiEndpoint: 'https://switch.internal:8443' })
    );
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('endpoint differs'),
      expect.anything()
    );
  });
});
