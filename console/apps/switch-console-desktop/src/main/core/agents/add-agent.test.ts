import type { PluginFs } from '@switch-console/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSettingsRelativePath } from './switch-settings-paths';

/** In-memory {@link PluginFs} keyed by the exact relative paths the writers use. */
function fakeFs(seed: Record<string, string> = {}): PluginFs {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    read: (p) => Promise.resolve(files.has(p) ? (files.get(p) as string) : null),
    write: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
    delete: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    list: () => Promise.resolve([...files.keys()]),
  };
}

// `repoAgents` is what `getPlugin` returns — set it to null in a test to
// simulate a provider without repo-agent definitions (e.g. Codex).
const h = vi.hoisted(() => {
  const writeDefinition = vi.fn(async () => {});
  const state: {
    workspace: PluginFs | null;
    repoAgents: object | null;
    nameTaken: boolean;
  } = {
    workspace: null,
    repoAgents: { writeDefinition },
    nameTaken: false,
  };
  return {
    state,
    writeDefinition,
    agentNameTaken: vi.fn(async () => state.nameTaken),
    registerAgentIdentity: vi.fn(async () => ({
      kind: 'created' as const,
      id: 'sw-1',
      apiKey: 'tok-123',
    })),
    createAgent: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
  };
});

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { repoAgents: h.state.repoAgents } }),
}));
vi.mock('./register-agent-identity', () => ({ registerAgentIdentity: h.registerAgentIdentity }));
vi.mock('./createAgent', () => ({ createAgent: h.createAgent }));
vi.mock('./agent-workspace-fs', () => ({
  resolveWorkspaceFsFor: vi.fn(async () => ({
    fs: h.state.workspace as PluginFs,
    close: vi.fn(),
  })),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: vi.fn(async () => ({ id: 'srv-1', apiUrl: 'https://switch.example.com' })),
}));
vi.mock('@main/core/locations/store', () => ({
  ensureLocation: vi.fn(async () => ({ id: 'loc-1' })),
  getLocationByHostDir: vi.fn(async () => ({ id: 'loc-1' })),
}));
vi.mock('./agent-name-taken', () => ({ agentNameTaken: h.agentNameTaken }));
vi.mock('@main/core/locations/path-utils', () => ({ checkIsValidDirectory: () => true }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { openLocation: vi.fn(async () => {}) },
}));
vi.mock('./setAgentAutoSession', () => ({
  reconcileAgentAutoSessionFromGateway: vi.fn(async () => {}),
}));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { addAgent } = await import('./add-agent');

function params(overrides: Record<string, unknown> = {}) {
  return {
    sshHost: null,
    dir: '/repo',
    name: 'codex-hoot',
    providerId: 'codex' as const,
    serverId: 'srv-1',
    description: 'Codex running in repo',
    autoSession: false,
    autoApprove: false,
    definitionAttributes: {},
    ...overrides,
  };
}

function credsOf(fs: PluginFs, slug: string): Promise<Record<string, string>> {
  return fs
    .read(agentSettingsRelativePath(slug))
    .then((raw) => (JSON.parse(raw as string) as { env: Record<string, string> }).env);
}

describe('addAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.nameTaken = false;
    h.state.repoAgents = { writeDefinition: h.writeDefinition };
    h.state.workspace = fakeFs();
    h.registerAgentIdentity.mockResolvedValue({ kind: 'created', id: 'sw-1', apiKey: 'tok-123' });
  });

  it('writes name-keyed credentials for a provider with no repo-agent definitions', async () => {
    // Codex has no `repoAgents` behavior. Before the credential write became
    // unconditional it got no credentials on disk at all, so its sessions
    // authenticated to Switch as whatever was in settings.local.json.
    h.state.repoAgents = null;
    const fs = h.state.workspace as PluginFs;

    const result = await addAgent(params());

    expect(result.kind).toBe('created');
    expect(await credsOf(fs, 'codex-hoot')).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'sw-1',
    });
    expect(h.writeDefinition).not.toHaveBeenCalled();
  });

  it('writes both credentials and an on-disk definition for a repo-agents provider', async () => {
    const fs = h.state.workspace as PluginFs;

    await addAgent(params({ providerId: 'claude', name: 'cc-hoot' }));

    expect((await credsOf(fs, 'cc-hoot')).SWITCH_API_TOKEN).toBe('tok-123');
    expect(h.writeDefinition).toHaveBeenCalledWith(
      fs,
      expect.objectContaining({ name: 'cc-hoot', description: 'Codex running in repo' })
    );
  });

  it('git-ignores the credentials directory so the token never enters VCS', async () => {
    const fs = h.state.workspace as PluginFs;
    await addAgent(params());
    expect(await fs.read('.switch/agents/.gitignore')).toBe('*\n');
  });

  it('registers under the gateway known-agent type derived from the provider', async () => {
    await addAgent(params());
    expect(h.registerAgentIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'codex-hoot', agentType: 'codex' })
    );

    await addAgent(params({ providerId: 'claude', name: 'cc-hoot' }));
    expect(h.registerAgentIdentity).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ agentType: 'claude-code' })
    );
  });

  it('writes nothing to the workspace when registration fails', async () => {
    h.registerAgentIdentity.mockResolvedValue({ kind: 'name-conflict' } as never);
    const fs = h.state.workspace as PluginFs;

    expect((await addAgent(params())).kind).toBe('name-conflict');
    expect(await fs.read(agentSettingsRelativePath('codex-hoot'))).toBeNull();
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it('refuses a name already taken in the location, without minting an identity', async () => {
    // The gateway's 409 is scoped to the Switch server, so it cannot see a name
    // that is free there and taken in this directory — where both agents would
    // then share one `.switch/agents/<name>.json`.
    h.state.nameTaken = true;

    expect((await addAgent(params())).kind).toBe('name-conflict');
    expect(h.registerAgentIdentity).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
  });
});
