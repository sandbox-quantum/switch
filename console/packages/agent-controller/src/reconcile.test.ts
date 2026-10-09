import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import { planReconcile, reconcile, type ReconcileDeps } from './reconcile';
import { emptyObservation } from './runtime';
import type { AgentAssignment, Assignment } from './schemas';
import type { GivenLogin } from './sealed-logins';
import { LAUNCH_GRACE_MS } from './status';
import { ControllerStore } from './store';
import { FakeRuntime } from './testing/fake-runtime';

const RELAY = 'http://127.0.0.1:43210';

function agent(overrides: Partial<AgentAssignment> = {}, definition = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 1,
    desired_state: 'running',
    ...overrides,
    definition: {
      name: 'scout',
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      directory: null,
      isolation: 'shared',
      ...definition,
    },
  };
}

function assignment(...agents: AgentAssignment[]): Assignment {
  return { revision: agents.reduce((sum, entry) => sum + entry.revision, 0), agents };
}

let dir: string;
let store: ControllerStore;
let runtime: FakeRuntime;
let minted: string[];
let forgotten: string[];
/** The relay's endpoint as the credentials are checked against it. */
let endpoint: string;
let clock: number;
let missingProvider: boolean;
let givenLogin: GivenLogin | null;

function deps(): ReconcileDeps {
  return {
    store,
    runtime,
    ensureCredentials: async (agentId) => {
      if (runtime.credentials.get(agentId)?.endpoint === endpoint) return false;
      minted.push(agentId);
      await runtime.writeCredentials(agentId, {
        endpoint,
        token: `swlr_${minted.length}`,
        hub: `${endpoint.replace('http', 'ws')}/hub`,
        providerLogin: null,
      });
      return true;
    },
    givenLogin: async () => givenLogin,
    forgetAgent: (agentId) => void forgotten.push(agentId),
    binaryPath: async (provider) => (missingProvider ? null : `/usr/bin/${provider}`),
    now: () => clock,
    log: silentLogger,
  };
}

beforeEach(() => {
  givenLogin = null;
  dir = mkdtempSync(join(tmpdir(), 'controller-reconcile-'));
  store = ControllerStore.open(join(dir, 'controller.db'));
  runtime = new FakeRuntime();
  minted = [];
  forgotten = [];
  endpoint = RELAY;
  clock = Date.parse('2026-01-01T00:00:00Z');
  missingProvider = false;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcile', () => {
  it('starts a running agent: points it at the relay, launches its watcher', async () => {
    await reconcile(assignment(agent()), deps());
    expect(minted).toEqual(['agent-1']);
    expect(runtime.credentials.get('agent-1')).toEqual({
      endpoint: RELAY,
      token: 'swlr_1',
      hub: `${RELAY.replace('http', 'ws')}/hub`,
      providerLogin: null,
    });
    const [launch] = runtime.launches();
    expect(launch!.options).toEqual({
      isolation: 'shared',
      restart: false,
      replaceIdentity: false,
      clearTakenOver: true,
    });
    expect(launch!.template.start.input.cwd).toBe('/data/workspaces/scout');
    expect(launch!.template.execution!.credentialsPath).toBe(
      '/data/agents/agent-1/credentials.json'
    );
    expect(launch!.template.execution!.binaryPath).toBe('/usr/bin/claude');
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: null });
    expect(store.restartsSince('agent-1', 0)).toBe(0);
  });

  it('gives an agent the login given to the machine, in a process of its own', async () => {
    givenLogin = {
      status: 'connected',
      provider: 'claude',
      revision: '2',
      kind: 'setup-token',
      credential: 'sk-ant-oat-given',
    };
    await reconcile(assignment(agent()), deps());
    const [launch] = runtime.launches();
    expect(launch!.options.isolation).toBe('isolated');
    expect(launch!.template.start.input.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-given',
    });
  });

  it('does nothing more once the revision is applied and running', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.calls.length = 0;
    const actions = await reconcile(assignment(agent()), deps());
    expect(actions).toEqual([]);
    expect(runtime.calls).toEqual([]);
  });

  it('hands a revision bump to the running agent host without restarting it, keeping its relay token', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile(assignment(agent({ revision: 2 }, { model: 'opus' })), deps());
    const launches = runtime.launches();
    expect(launches).toHaveLength(2);
    expect(launches[1]!.options).toMatchObject({
      restart: false,
      replaceIdentity: false,
    });
    expect(launches[1]!.template.start.input.model).toEqual({ id: 'opus' });
    expect(minted).toEqual(['agent-1']);
    expect(store.agent('agent-1')?.appliedRevision).toBe(2);
    expect(store.restartsSince('agent-1', 0)).toBe(0);
  });

  it('replaces the saved identity when the provider or directory changes', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile(assignment(agent({ revision: 2 }, { provider: 'codex' })), deps());
    await reconcile(
      assignment(agent({ revision: 3 }, { provider: 'codex', directory: '/srv/repo' })),
      deps()
    );
    const launches = runtime.launches();
    expect(launches[1]!.options).toMatchObject({ restart: true, replaceIdentity: true });
    expect(launches[2]!.options).toMatchObject({ restart: true, replaceIdentity: true });
    expect(launches[2]!.template.start.input.cwd).toBe('/srv/repo');
  });

  it('stops an agent whose desired state is stopped, and records the revision', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile(assignment(agent({ revision: 2, desired_state: 'stopped' })), deps());
    expect(runtime.calls.at(-1)).toEqual({ kind: 'stop', agentId: 'agent-1', wait: false });
    expect(store.agent('agent-1')?.appliedRevision).toBe(2);
    runtime.calls.length = 0;
    await reconcile(assignment(agent({ revision: 2, desired_state: 'stopped' })), deps());
    expect(runtime.calls).toEqual([]);
  });

  it('records a stopped agent that never ran without touching its watcher', async () => {
    await reconcile(assignment(agent({ desired_state: 'stopped' })), deps());
    expect(runtime.calls).toEqual([]);
    expect(store.agent('agent-1')?.appliedRevision).toBe(1);
  });

  it('stops a removed agent, deletes its relay token and forgets it', async () => {
    await reconcile(assignment(agent()), deps());
    store.saveCursor('agent-1', 12, '2026-01-01T00:00:00Z');
    await reconcile({ revision: 9, agents: [] }, deps());
    expect(runtime.calls.slice(-2)).toEqual([
      { kind: 'stop', agentId: 'agent-1', wait: false },
      { kind: 'deleteCredentials', agentId: 'agent-1' },
    ]);
    expect(runtime.credentials.has('agent-1')).toBe(false);
    expect(forgotten).toEqual(['agent-1']);
    expect(store.agent('agent-1')).toBeNull();
    expect(store.cursors().has('agent-1')).toBe(false);
  });

  it('starts again a watcher that is gone without a failure, as after a reboot', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.kill('agent-1', null);
    clock += LAUNCH_GRACE_MS;
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(2);
    expect(runtime.launches()[1]!.options).toMatchObject({ restart: false, clearTakenOver: false });
    expect(store.restartsSince('agent-1', 0)).toBe(1);
  });

  it('leaves a failed watcher down until something asks for it', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.kill('agent-1', 'Shared SDK host exited with code 1.');
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(1);
  });

  it('leaves a watcher that was taken over standing down', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.kill('agent-1', null);
    runtime.observation('agent-1').takenOver = {
      at: '2026-01-01T00:00:00Z',
      reason: 'another client',
      connectionId: 'c',
    };
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(1);
  });

  it('does not launch again a watcher still coming up after its launch', async () => {
    await reconcile(assignment(agent()), deps());
    // Launched, but not yet showing as alive: its owner records are not written yet.
    runtime.kill('agent-1', null);
    clock += 500;
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(1);
    clock += LAUNCH_GRACE_MS;
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(2);
  });

  it('restarts a running watcher whose relay credentials had to be rewritten', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.calls.length = 0;
    endpoint = 'http://127.0.0.1:50000';
    await reconcile(assignment(agent()), deps());
    expect(runtime.credentials.get('agent-1')?.endpoint).toBe('http://127.0.0.1:50000');
    expect(runtime.launches()).toHaveLength(1);
    expect(runtime.launches()[0]!.options).toMatchObject({ restart: true, clearTakenOver: false });
    expect(store.restartsSince('agent-1', 0)).toBe(1);
  });

  it('relaunches a watcher that failed on its relay token only once it has a new one', async () => {
    await reconcile(assignment(agent()), deps());
    const refused =
      'Shared SDK watcher was evicted: Switch rejected the agent credentials (HTTP 401)';
    runtime.kill('agent-1', refused);
    clock += LAUNCH_GRACE_MS;
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(1);
    endpoint = 'http://127.0.0.1:50000';
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(2);
  });

  it('refuses to apply a revision older than the one applied', async () => {
    await reconcile(assignment(agent({ revision: 5 })), deps());
    const actions = await reconcile(assignment(agent({ revision: 4 })), deps());
    expect(actions).toEqual([expect.objectContaining({ kind: 'hold' })]);
    expect(runtime.launches()).toHaveLength(1);
  });

  it('records an unknown provider as an invalid definition, once', async () => {
    await reconcile(assignment(agent({}, { provider: 'gemini' })), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'definition_invalid',
      revision: 1,
    });
    expect(runtime.calls).toEqual([]);
    expect(await reconcile(assignment(agent({}, { provider: 'gemini' })), deps())).toEqual([]);
  });

  it('records an advanced configuration field it does not know as invalid, naming it', async () => {
    const entry = agent({}, { advanced_config: { effort: 'high', sandbox: 'workspace-write' } });
    await reconcile(assignment(entry), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'definition_invalid',
      detail: expect.stringContaining("'sandbox'"),
    });
    expect(runtime.calls).toEqual([]);
  });

  it('records an advanced configuration value a session cannot start with as invalid', async () => {
    await reconcile(assignment(agent({}, { advanced_config: { maxTurns: 2.5 } })), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'definition_invalid',
      detail: expect.stringContaining('maxTurns'),
    });
    expect(runtime.calls).toEqual([]);
  });

  it('records an agent id that cannot be a directory name as invalid', async () => {
    await reconcile(assignment(agent({ agent_id: '../escape' })), deps());
    expect(store.agent('../escape')?.failure?.reason).toBe('definition_invalid');
    await reconcile({ revision: 2, agents: [] }, deps());
    expect(store.agent('../escape')).toBeNull();
    expect(runtime.calls).toEqual([]);
  });

  it('records a missing provider CLI, and retries on the next pass', async () => {
    missingProvider = true;
    await reconcile(assignment(agent()), deps());
    expect(store.agent('agent-1')?.failure?.reason).toBe('provider_not_installed');
    missingProvider = false;
    await reconcile(assignment(agent()), deps());
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: null });
  });

  it('records a launch that fails as internal, and carries on with the next agent', async () => {
    runtime.failNextLaunch = new Error('launcher exploded');
    await reconcile(assignment(agent(), agent({ agent_id: 'agent-2' }, { name: 'other' })), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'internal',
      detail: 'launcher exploded',
    });
    expect(store.agent('agent-2')?.appliedRevision).toBe(1);
  });
});

describe('planReconcile', () => {
  it('holds an agent whose desired state it does not know', () => {
    const actions = planReconcile({
      assignment: assignment(agent({ desired_state: 'unknown' })),
      rows: [],
      observations: new Map([['agent-1', emptyObservation()]]),
      credentialsChanged: new Set(),
      nowMs: 0,
    });
    expect(actions).toEqual([expect.objectContaining({ kind: 'hold', agentId: 'agent-1' })]);
  });

  it('restarts a running watcher that is being turned off', () => {
    const actions = planReconcile({
      assignment: assignment(agent()),
      rows: [
        {
          agentId: 'agent-1',
          appliedRevision: 1,
          changedAt: '2026-01-01T00:00:00Z',
          failure: null,
        },
      ],
      observations: new Map([
        [
          'agent-1',
          { ...emptyObservation(), alive: true, flags: { enabled: false, spawn: false } },
        ],
      ]),
      credentialsChanged: new Set(),
      nowMs: 0,
    });
    expect(actions).toEqual([expect.objectContaining({ kind: 'start', restart: true })]);
  });
});
