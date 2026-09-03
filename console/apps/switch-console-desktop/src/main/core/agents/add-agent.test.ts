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
  // A faithful-enough stand-in for a repo-agents provider: the config sync
  // renders the definition and writes it through the workspace fs, so the mock
  // has to answer where it goes and what it looks like.
  const repoAgents = {
    writeDefinition,
    definitionPath: (name: string) => `.claude/agents/${name}.md`,
    renderDefinition: (attributes: Record<string, unknown>) =>
      `---\nname: ${String(attributes.name)}\ndescription: ${String(attributes.description)}\n---\n\n${String(
        attributes.instructions || attributes.description
      )}\n`,
    readDefinition: async () => null,
  };
  const state: {
    workspace: PluginFs | null;
    repoAgents: object | null;
    nameTaken: boolean;
  } = {
    workspace: null,
    repoAgents,
    nameTaken: false,
  };
  return {
    state,
    repoAgents,
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
vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
}));
vi.mock('@main/db/schema', () => ({ agents: { id: 'id', switchAgentId: 'switchAgentId' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const { addAgent } = await import('./add-agent');
const { trackEvent } = await import('@main/core/telemetry/telemetry-service');

function params(overrides: Record<string, unknown> = {}) {
  return {
    sshHost: null,
    dir: '/repo',
    name: 'codex-hoot',
    providerId: 'codex' as const,
    serverId: 'srv-1',
    description: 'Codex running in repo',
    iconUrl: null,
    autoSession: false,
    autoApprove: false,
    instructions: '',
    definitionAttributes: {},
    entryPoint: 'unknown' as const,
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
    h.state.repoAgents = h.repoAgents;
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
    expect(await fs.read('.claude/agents/codex-hoot.md')).toBeNull();
  });

  it('writes both credentials and an on-disk definition for a repo-agents provider', async () => {
    const fs = h.state.workspace as PluginFs;

    await addAgent(params({ providerId: 'claude', name: 'cc-hoot' }));

    expect((await credsOf(fs, 'cc-hoot')).SWITCH_API_TOKEN).toBe('tok-123');
    const definition = await fs.read('.claude/agents/cc-hoot.md');
    expect(definition).toContain('name: cc-hoot');
    expect(definition).toContain('description: Codex running in repo');
  });

  it('records the agent’s instructions in its committed config file', async () => {
    const fs = h.state.workspace as PluginFs;

    await addAgent(params({ providerId: 'claude', name: 'cc-hoot', instructions: 'Be careful.' }));

    const config = JSON.parse((await fs.read('.switch/config/cc-hoot.json')) ?? '{}');
    expect(config.instructions).toBe('Be careful.');
    // And it reaches the provider's own file, which is what actually runs.
    expect(await fs.read('.claude/agents/cc-hoot.md')).toContain('Be careful.');
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

  it('refuses a name another Switch Console install already provisioned here, without minting an identity', async () => {
    // A second install has its own database, so `agentNameTaken` cannot see its
    // agent; the credentials file it left in the directory is the only trace.
    // Refusing after registration would be too late — this agent's token is
    // returned once, so it would already be lost (CHOO-1960).
    const theirs = JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://their-switch.example.com',
        SWITCH_API_TOKEN: 'their-token',
        SWITCH_AGENT_ID: 'their-agent',
      },
    });
    h.state.workspace = fakeFs({ [agentSettingsRelativePath('codex-hoot')]: theirs });

    const result = await addAgent(params());

    expect(result).toEqual({
      kind: 'credentials-conflict',
      endpoint: 'https://their-switch.example.com',
    });
    expect(h.registerAgentIdentity).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(
      await (h.state.workspace as PluginFs).read(agentSettingsRelativePath('codex-hoot'))
    ).toBe(theirs);
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

  describe('what it reports', () => {
    beforeEach(() => {
      vi.mocked(trackEvent).mockClear();
    });

    it('reports a creation that failed, with the reason as a code', async () => {
      // The success is reported from the `agent:created` hook, which by
      // definition never fires here — so without this the entire failure
      // population is missing rather than merely unexplained.
      h.registerAgentIdentity.mockResolvedValue({ kind: 'unauthenticated' } as never);

      await addAgent(params({ entryPoint: 'command_palette' }));

      expect(trackEvent).toHaveBeenCalledWith('agent_created', {
        agent_type: 'codex',
        location: 'local',
        outcome: 'failure',
        failure_reason: 'unauthenticated',
        entry_point: 'command_palette',
      });
    });

    it('reports a refusal that happens before anything is minted', async () => {
      h.state.nameTaken = true;

      await addAgent(params({ entryPoint: 'sidebar' }));

      expect(trackEvent).toHaveBeenCalledWith(
        'agent_created',
        expect.objectContaining({ outcome: 'failure', failure_reason: 'name_conflict' })
      );
    });

    it('describes a remote failure as remote, from what was asked for', async () => {
      // There is no row to read the location from — the agent was never
      // created. The parameters are the only account of what was attempted.
      h.registerAgentIdentity.mockResolvedValue({ kind: 'unauthenticated' } as never);

      await addAgent(params({ sshHost: 'build-box', entryPoint: 'server_page' }));

      expect(trackEvent).toHaveBeenCalledWith(
        'agent_created',
        expect.objectContaining({ location: 'remote' })
      );
    });

    it('reports a failure that arrives as a throw, after the identity was minted', async () => {
      // The worst case this function has: the identity exists on the gateway and
      // nothing here points at it. Without this, the one population that leaves
      // an orphan behind is the one nothing counts.
      h.createAgent.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));

      await expect(addAgent(params({ entryPoint: 'agent_page' }))).rejects.toThrow(
        'UNIQUE constraint failed'
      );

      expect(trackEvent).toHaveBeenCalledWith('agent_created', {
        agent_type: 'codex',
        location: 'local',
        outcome: 'failure',
        failure_reason: 'error',
        entry_point: 'agent_page',
      });
    });

    it('reports a throw once, and never its message', async () => {
      h.registerAgentIdentity.mockRejectedValueOnce(
        new Error('/Users/someone/secret-project could not be registered')
      );

      await expect(addAgent(params())).rejects.toThrow();

      expect(vi.mocked(trackEvent).mock.calls).toHaveLength(1);
      expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain('secret-project');
    });

    it('reports nothing itself when the agent is created', async () => {
      // Reporting here as well as from the hook would double-count every
      // successful creation.
      await addAgent(params());

      expect(trackEvent).not.toHaveBeenCalled();
    });

    it('never puts the failure message in the payload', async () => {
      h.registerAgentIdentity.mockResolvedValue({
        kind: 'error',
        message: '/Users/someone/secret-project is not writable',
      } as never);

      await addAgent(params());

      expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain('secret-project');
    });
  });
});
