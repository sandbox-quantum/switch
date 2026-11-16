import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERTEX_CREDENTIALS_FILE } from '@switch-console/agent-providers-box';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteAgentFolders,
  deleteLoginCopies,
  LEFTOVER_MIN_MISSING_MS,
  LeftoverWatch,
} from './agent-removal';
import { silentLogger } from './log';
import { dataLayout } from './paths';
import {
  CREDENTIAL_RESTART_WAIT_MS,
  type CredentialChange,
  CredentialRestarts,
  planReconcile,
  reconcile,
  type ReconcileDeps,
} from './reconcile';
import { type AgentObservation, emptyObservation } from './runtime';
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
      auto_mode: false,
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

  it('stops a removed agent and waits for it, deletes its relay token and forgets it', async () => {
    await reconcile(assignment(agent()), deps());
    store.saveCursor('agent-1', 12, '2026-01-01T00:00:00Z');
    await reconcile({ revision: 9, agents: [] }, deps());
    expect(runtime.calls.slice(-2)).toEqual([
      // Waited for, so its folders are deleted only once it has gone.
      { kind: 'stop', agentId: 'agent-1', wait: true },
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

describe('an agent whose host is stopped until its next message', () => {
  const rowAt = (appliedRevision: number) => ({
    agentId: 'agent-1',
    appliedRevision,
    changedAt: '2026-01-01T00:00:00Z',
    failure: null,
  });
  const resting = { ...emptyObservation(), flags: { enabled: false, spawn: false } };

  it('is not started for being down, nor restarted for new credentials', () => {
    const plan = (suspended: Set<string>, credentialsChanged = new Set<string>()) =>
      planReconcile({
        assignment: assignment(agent()),
        rows: [rowAt(1)],
        observations: new Map([['agent-1', resting]]),
        credentialsChanged,
        nowMs: Date.parse('2026-01-01T01:00:00Z'),
        suspended,
      });
    // Without the suspension, a host that is down is started: that would undo every rest.
    expect(plan(new Set())).toEqual([
      expect.objectContaining({ kind: 'start', why: 'its agent host is not running' }),
    ]);
    expect(plan(new Set(['agent-1']))).toEqual([]);
    expect(plan(new Set(['agent-1']), new Set(['agent-1']))).toEqual([]);
  });

  it('is started at a new revision, which clears the suspension, then the host comes up', async () => {
    const cleared: string[] = [];
    let suspended = true;
    const withRest: ReconcileDeps = {
      ...deps(),
      rest: {
        suspended: () => suspended,
        clear: (agentId) => {
          suspended = false;
          cleared.push(agentId);
        },
      },
    };
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    runtime.agents.set('agent-1', resting);
    const actions = await reconcile(assignment(agent({ revision: 2 })), withRest);
    expect(actions).toEqual([expect.objectContaining({ kind: 'start' })]);
    expect(cleared).toEqual(['agent-1']);
    expect(runtime.launches()).toHaveLength(1);
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 2 });
  });

  it('is cleared when its owner stops it or it is removed, so its next message starts nothing', async () => {
    const cleared: string[] = [];
    const withRest: ReconcileDeps = {
      ...deps(),
      rest: { suspended: () => true, clear: (agentId) => void cleared.push(agentId) },
    };
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    runtime.agents.set('agent-1', { ...emptyObservation(), flags: { enabled: true, spawn: true } });
    await reconcile(assignment(agent({ revision: 2, desired_state: 'stopped' })), withRest);
    expect(cleared).toEqual(['agent-1']);
    await reconcile(assignment(), withRest);
    expect(cleared).toEqual(['agent-1', 'agent-1']);
    expect(forgotten).toEqual(['agent-1']);
  });
});

describe('removing an agent deletes its files', () => {
  let data: string;
  let sessions: string;
  let leftovers: LeftoverWatch;
  const layout = () => dataLayout(data);
  const plant = (agentId: string) => {
    const l = layout();
    mkdirSync(join(l.agentDir(agentId)), { recursive: true });
    writeFileSync(l.agentCredentials(agentId), '{"token":"swlr_x"}');
    writeFileSync(join(l.agentDir(agentId), 'guard-stop.json'), '{}');
    mkdirSync(join(l.watcherRoot(agentId), 'provider-home'), { recursive: true });
    writeFileSync(join(l.watcherRoot(agentId), VERTEX_CREDENTIALS_FILE), '{"type":"x"}');
    writeFileSync(join(l.watcherRoot(agentId), 'placements.json'), '{"placements":{}}');
    const session = join(sessions, createHash('sha256').update(`s-${agentId}`).digest('hex'));
    mkdirSync(session, { recursive: true });
    writeFileSync(
      join(session, 'config.json'),
      JSON.stringify({
        session: { agentId },
        execution: { credentialsPath: l.agentCredentials(agentId) },
      })
    );
    return session;
  };
  const removalDeps = (): ReconcileDeps => ({
    ...deps(),
    removal: { layout: layout(), sessionsBase: sessions, log: silentLogger, leftovers },
  });
  /** Two successful fetches of the same assignment, the guard's minimum apart. */
  const fetchedTwice = async (held: Assignment) => {
    await reconcile(held, removalDeps(), { fetched: true });
    clock += LEFTOVER_MIN_MISSING_MS;
    await reconcile(held, removalDeps(), { fetched: true });
  };

  beforeEach(() => {
    data = join(dir, 'data');
    sessions = join(dir, 'sdk-sessions');
    leftovers = new LeftoverWatch();
    mkdirSync(join(data, 'agents'), { recursive: true });
    mkdirSync(join(data, 'watchers'), { recursive: true });
    mkdirSync(sessions, { recursive: true });
  });

  it('deletes the login copies before stopping it, and its folders and sessions only after two fetches 10 minutes apart', async () => {
    await reconcile(assignment(agent()), removalDeps(), { fetched: true });
    const session = plant('agent-1');
    const keptSession = plant('agent-2');
    const l = layout();
    const seenAtStop: boolean[] = [];
    const stop = runtime.stop.bind(runtime);
    runtime.stop = async (agentId, options) => {
      seenAtStop.push(
        existsSync(l.agentCredentials(agentId)),
        existsSync(join(l.watcherRoot(agentId), VERTEX_CREDENTIALS_FILE))
      );
      await stop(agentId, options);
    };
    const onlyAgent2 = assignment(agent({ agent_id: 'agent-2' }));
    await reconcile(onlyAgent2, removalDeps(), { fetched: true });
    expect(seenAtStop).toEqual([false, false]);
    // Removed, but not yet missing for long enough: the folders wait.
    expect(existsSync(join(l.watcherRoot('agent-1'), 'placements.json'))).toBe(true);
    expect(existsSync(session)).toBe(true);

    clock += LEFTOVER_MIN_MISSING_MS;
    await reconcile(onlyAgent2, removalDeps(), { fetched: true });
    expect(existsSync(l.agentDir('agent-1'))).toBe(false);
    expect(existsSync(l.watcherRoot('agent-1'))).toBe(false);
    expect(existsSync(session)).toBe(false);
    // Another agent's files and sessions stay.
    expect(existsSync(l.agentCredentials('agent-2'))).toBe(true);
    expect(existsSync(join(l.watcherRoot('agent-2'), VERTEX_CREDENTIALS_FILE))).toBe(true);
    expect(existsSync(keptSession)).toBe(true);
  });

  it('keeps the folders of a host still running after the stop, and clears them once it is gone', async () => {
    await reconcile(assignment(agent()), removalDeps(), { fetched: true });
    plant('agent-1');
    plant('agent-2');
    const l = layout();
    const stop = runtime.stop.bind(runtime);
    let stubborn = true;
    runtime.stop = async (agentId, options) => {
      await stop(agentId, options);
      if (stubborn) runtime.observation(agentId).alive = true;
    };
    const onlyAgent2 = assignment(agent({ agent_id: 'agent-2' }));
    await fetchedTwice(onlyAgent2);
    expect(existsSync(l.agentCredentials('agent-1'))).toBe(false);
    expect(existsSync(join(l.watcherRoot('agent-1'), 'provider-home'))).toBe(false);
    expect(existsSync(join(l.watcherRoot('agent-1'), 'placements.json'))).toBe(true);
    expect(store.agent('agent-1')).toBeNull();

    stubborn = false;
    runtime.observation('agent-1').alive = false;
    await reconcile(onlyAgent2, removalDeps(), { fetched: true });
    expect(existsSync(l.agentDir('agent-1'))).toBe(false);
    expect(existsSync(l.watcherRoot('agent-1'))).toBe(false);
  });

  it("clears leftovers of agents removed before, never an assigned agent's, and follows no link out", async () => {
    const leftover = plant('r6-old');
    plant('agent-1');
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'not the controller’s');
    const l = layout();
    symlinkSync(outside, join(l.watcherRoot('r6-old'), 'provider-data'));
    symlinkSync(outside, join(l.watcherRoot('r6-old'), 'workspace'));
    symlinkSync(outside, join(data, 'agents', 'linked-agent'));
    await fetchedTwice(assignment(agent()));

    expect(existsSync(l.agentDir('r6-old'))).toBe(false);
    expect(existsSync(l.watcherRoot('r6-old'))).toBe(false);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(l.agentCredentials('agent-1'))).toBe(true);
    expect(existsSync(join(l.watcherRoot('agent-1'), VERTEX_CREDENTIALS_FILE))).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(lstatSync(join(data, 'agents', 'linked-agent')).isSymbolicLink()).toBe(true);
  });

  describe('the sweep guard', () => {
    it('never sweeps on an assignment that lists no agent', async () => {
      plant('r6-old');
      await fetchedTwice({ revision: 3, agents: [] });
      clock += LEFTOVER_MIN_MISSING_MS;
      await reconcile({ revision: 3, agents: [] }, removalDeps(), { fetched: true });
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(true);
    });

    it('never sweeps on a held assignment, only straight after a fetch', async () => {
      plant('r6-old');
      await reconcile(assignment(agent()), removalDeps());
      clock += LEFTOVER_MIN_MISSING_MS;
      await reconcile(assignment(agent()), removalDeps());
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(true);
    });

    it('waits the full 10 minutes between the two fetches', async () => {
      plant('r6-old');
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      clock += LEFTOVER_MIN_MISSING_MS - 1;
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(true);
      clock += 1;
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(false);
    });

    it('starts the count again after a failed fetch, or an empty assignment', async () => {
      plant('r6-old');
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      leftovers.fetchFailed();
      clock += LEFTOVER_MIN_MISSING_MS;
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(true);
      await reconcile({ revision: 3, agents: [] }, removalDeps(), { fetched: true });
      clock += LEFTOVER_MIN_MISSING_MS;
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(true);
      clock += LEFTOVER_MIN_MISSING_MS;
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      expect(existsSync(layout().watcherRoot('r6-old'))).toBe(false);
    });

    it('forgets an agent that comes back, so it is never deleted on its old count', async () => {
      plant('agent-2');
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      clock += LEFTOVER_MIN_MISSING_MS;
      const both = assignment(agent(), agent({ agent_id: 'agent-2' }));
      await reconcile(both, removalDeps(), { fetched: true });
      clock += 1000;
      await reconcile(assignment(agent()), removalDeps(), { fetched: true });
      expect(existsSync(layout().agentDir('agent-2'))).toBe(true);
    });
  });

  it('builds no path from an id that is not a safe folder name', async () => {
    const removal = { layout: layout(), sessionsBase: sessions, log: silentLogger };
    expect(await deleteAgentFolders(removal, '../watchers')).toEqual({ deleted: [], failed: [] });
    expect(existsSync(join(data, 'watchers'))).toBe(true);
    expect(await deleteLoginCopies(removal, '..')).toEqual({ deleted: [], failed: [] });
  });

  it("leaves a session whose config names this agent but another controller's credentials", async () => {
    await reconcile(assignment(agent()), removalDeps(), { fetched: true });
    plant('agent-1');
    plant('agent-2');
    const foreign = join(sessions, createHash('sha256').update('console-session').digest('hex'));
    mkdirSync(foreign);
    writeFileSync(
      join(foreign, 'config.json'),
      JSON.stringify({
        session: { agentId: 'agent-1' },
        execution: { credentialsPath: '/elsewhere/agents/agent-1/credentials.json' },
      })
    );
    await fetchedTwice(assignment(agent({ agent_id: 'agent-2' })));
    expect(existsSync(layout().watcherRoot('agent-1'))).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe('a login given while a session is mid-turn', () => {
  // The give runs `takeUpLogin`, which reconciles at once. The credentials file
  // is rewritten with the new login, so the agent counts as `credentialsChanged`,
  // and a live host was restarted "for its relay endpoint or token" with no look
  // at `busy`: a turn in progress was cut off, and as an asked stop it owed the
  // room no line. Seen live on C at 18:22:08 (27 Oct). It now waits for the
  // turn, as a self-update does, up to CREDENTIAL_RESTART_WAIT_MS.
  const live = (busyIds: string[]) => ({
    ...emptyObservation(),
    alive: true,
    flags: { enabled: true, spawn: true },
    health: {
      state: 'connected' as const,
      detail: null,
      since: '2026-01-01T00:00:00Z',
      placements: { 'session-1': 'room-1' },
      busy: busyIds,
      sessions: { 'session-1': 'active' as const },
      pid: 4242,
      updatedAt: '2026-01-01T00:00:00Z',
      current: true,
    },
  });
  const t0 = Date.parse('2026-01-01T01:00:00Z');
  const plan = (observation: AgentObservation, nowMs: number, owedSince?: number) =>
    planReconcile({
      assignment: assignment(agent()),
      rows: [
        {
          agentId: 'agent-1',
          appliedRevision: 1,
          changedAt: '2026-01-01T00:00:00Z',
          failure: null,
        },
      ],
      observations: new Map([['agent-1', observation]]),
      credentialsChanged: new Set(['agent-1']),
      credentialsOwedSince: owedSince === undefined ? undefined : new Map([['agent-1', owedSince]]),
      nowMs,
    });

  it('holds the restart while a session is mid-turn (failed before the fix: it restarted at once)', () => {
    expect(plan(live(['session-1']), t0, t0)).toEqual([
      expect.objectContaining({ kind: 'hold', agentId: 'agent-1' }),
    ]);
  });

  it('restarts once no session is mid-turn, as a restart nobody asked for', () => {
    expect(plan(live([]), t0 + 60_000, t0)).toEqual([
      expect.objectContaining({
        kind: 'start',
        restart: true,
        asked: false,
        why: 'its relay endpoint or token changed',
      }),
    ]);
  });

  it('restarts anyway after the wait, unasked, so the cut-off turn owes its room a line', () => {
    expect(plan(live(['session-1']), t0 + CREDENTIAL_RESTART_WAIT_MS, t0)).toEqual([
      expect.objectContaining({ kind: 'start', restart: true, asked: false }),
    ]);
  });

  it('restarts at once when the relay endpoint or token changed: the old host is already cut off', () => {
    // Not owed (only a login change is): no waiting, even mid-turn.
    expect(plan(live(['session-1']), t0)).toEqual([
      expect.objectContaining({ kind: 'start', restart: true, asked: false }),
    ]);
  });

  it('leaves a resting agent alone: it takes the new login at its next wake', () => {
    expect(
      planReconcile({
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
          ['agent-1', { ...emptyObservation(), flags: { enabled: false, spawn: false } }],
        ]),
        credentialsChanged: new Set(['agent-1']),
        credentialsOwedSince: new Map([['agent-1', t0]]),
        suspended: new Set(['agent-1']),
        nowMs: t0,
      })
    ).toEqual([]);
  });

  it('remembers the restart it owes across passes, then pays it once, when the turn ends', async () => {
    const owed = new CredentialRestarts();
    // The first pass rewrites only the login in the credentials; later ones find nothing new.
    let change: 'login' | false = 'login';
    const withOwed: ReconcileDeps = {
      ...deps(),
      ensureCredentials: async () => {
        const now = change;
        change = false;
        return now;
      },
      credentialRestarts: owed,
    };
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    runtime.agents.set('agent-1', live(['session-1']));
    // The pass that rewrites the login finds a session mid-turn.
    await reconcile(assignment(agent()), withOwed);
    expect(runtime.launches()).toHaveLength(0);
    expect([...owed.owed().keys()]).toEqual(['agent-1']);
    // A later pass rewrites nothing, but still owes the restart.
    clock += 30_000;
    await reconcile(assignment(agent()), withOwed);
    expect(runtime.launches()).toHaveLength(0);
    // The turn ends: the next pass restarts it, once, and owes nothing more.
    runtime.agents.set('agent-1', live([]));
    clock += 30_000;
    await reconcile(assignment(agent()), withOwed);
    expect(runtime.launches()).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ restart: true, asked: false }),
      }),
    ]);
    expect(owed.owed().size).toBe(0);
    await reconcile(assignment(agent()), withOwed);
    expect(runtime.launches()).toHaveLength(1);
  });

  it('says it is holding once per debt, not on every pass', async () => {
    const owed = new CredentialRestarts();
    const holds: unknown[] = [];
    let change: 'login' | false = 'login';
    const withOwed: ReconcileDeps = {
      ...deps(),
      log: {
        ...silentLogger,
        warn: (message, fields) => {
          if (message === 'Leaving agent as it is') holds.push(fields);
        },
      },
      ensureCredentials: async () => {
        const now = change;
        change = false;
        return now;
      },
      credentialRestarts: owed,
    };
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    runtime.agents.set('agent-1', live(['session-1']));
    for (let pass = 0; pass < 4; pass++) {
      await reconcile(assignment(agent()), withOwed);
      clock += 10_000;
    }
    expect(holds).toHaveLength(1);
    // Paid, then owed again: a new debt is said again.
    runtime.agents.set('agent-1', live([]));
    await reconcile(assignment(agent()), withOwed);
    runtime.agents.set('agent-1', live(['session-1']));
    change = 'login';
    await reconcile(assignment(agent()), withOwed);
    await reconcile(assignment(agent()), withOwed);
    expect(holds).toHaveLength(2);
  });

  it('restarts at once, unasked, when the login is withdrawn: it must not stay in use for a turn', async () => {
    const owed = new CredentialRestarts();
    // Given (owed, held for the turn), then withdrawn while the turn still runs.
    const changes: CredentialChange[] = ['login', 'withdrawn'];
    const withOwed: ReconcileDeps = {
      ...deps(),
      ensureCredentials: async () => changes.shift() ?? false,
      credentialRestarts: owed,
    };
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    runtime.agents.set('agent-1', live(['session-1']));
    await reconcile(assignment(agent()), withOwed);
    expect(runtime.launches()).toHaveLength(0);
    expect([...owed.owed().keys()]).toEqual(['agent-1']);
    clock += 30_000;
    await reconcile(assignment(agent()), withOwed);
    expect(runtime.launches()).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ restart: true, asked: false }),
      }),
    ]);
    expect(owed.owed().size).toBe(0);
  });

  describe('the login copies left in the box', () => {
    // The agent host writes the given login under its root (for Vertex,
    // `provider-home/google-credentials.json`, beside `credentials.json`).
    let root: string;
    const vertex = () => join(root, VERTEX_CREDENTIALS_FILE);
    const plant = () => {
      mkdirSync(join(root, 'provider-home'), { recursive: true });
      writeFileSync(vertex(), '{"secret":true}');
      writeFileSync(`${vertex()}.switch-credential`, 'fingerprint');
    };
    beforeEach(() => {
      root = join(dir, 'watchers', 'agent-1');
      runtime.agentStateRoot = () => root;
      plant();
      store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    });

    it('a withdrawn login leaves no copy, at once, even for an agent at rest', async () => {
      let suspended = true;
      const changes: CredentialChange[] = ['withdrawn'];
      await reconcile(assignment(agent()), {
        ...deps(),
        ensureCredentials: async () => changes.shift() ?? false,
        rest: { suspended: () => suspended, clear: () => (suspended = false) },
      });
      expect(existsSync(vertex())).toBe(false);
      expect(existsSync(`${vertex()}.switch-credential`)).toBe(false);
      // At rest: nothing started; the copy went anyway.
      expect(runtime.launches()).toHaveLength(0);
    });

    it('a changed login leaves no old copy for an agent at rest, before its next wake', async () => {
      let suspended = true;
      const changes: CredentialChange[] = ['login'];
      await reconcile(assignment(agent()), {
        ...deps(),
        ensureCredentials: async () => changes.shift() ?? false,
        rest: { suspended: () => suspended, clear: () => (suspended = false) },
      });
      expect(existsSync(vertex())).toBe(false);
      expect(existsSync(`${vertex()}.switch-credential`)).toBe(false);
      // Still at rest: nothing started. Its next wake writes the new login.
      expect(runtime.launches()).toHaveLength(0);
    });

    it('a changed login leaves no old copy for a stopped agent that is not resting', async () => {
      // Its host gave up after repeated failures: not running, not resting,
      // and not started again by this pass.
      runtime.agents.set('agent-1', {
        ...emptyObservation(),
        failure: 'the agent host kept failing',
      });
      const changes: CredentialChange[] = ['login'];
      await reconcile(assignment(agent()), {
        ...deps(),
        ensureCredentials: async () => changes.shift() ?? false,
      });
      expect(existsSync(vertex())).toBe(false);
      expect(existsSync(`${vertex()}.switch-credential`)).toBe(false);
      expect(runtime.launches()).toHaveLength(0);
    });

    it('a changed login is left alone for a running agent until its restart', async () => {
      const changes: CredentialChange[] = ['login'];
      runtime.agents.set('agent-1', live(['session-1']));
      await reconcile(assignment(agent()), {
        ...deps(),
        ensureCredentials: async () => changes.shift() ?? false,
        credentialRestarts: new CredentialRestarts(),
      });
      // Mid-turn, it still signs in with the copy it has.
      expect(existsSync(vertex())).toBe(true);
    });

    it('a changed login keeps the old copy while the turn runs, and drops it at the restart', async () => {
      const owed = new CredentialRestarts();
      let change: 'login' | false = 'login';
      const withOwed: ReconcileDeps = {
        ...deps(),
        ensureCredentials: async () => {
          const now = change;
          change = false;
          return now;
        },
        credentialRestarts: owed,
      };
      runtime.agents.set('agent-1', live(['session-1']));
      await reconcile(assignment(agent()), withOwed);
      // The running turn still signs in with it.
      expect(existsSync(vertex())).toBe(true);
      runtime.agents.set('agent-1', live([]));
      clock += 30_000;
      await reconcile(assignment(agent()), withOwed);
      expect(runtime.launches()).toHaveLength(1);
      // Gone before the new host starts, which writes the new login itself.
      expect(existsSync(vertex())).toBe(false);
    });
  });
});

describe('a login fronted by the provider gateway', () => {
  it('starts the CLI with the gateway’s base URL and token, never the login', async () => {
    givenLogin = {
      status: 'connected',
      provider: 'claude',
      revision: '1',
      kind: 'api-key',
      credential: 'sk-ant-api03-REAL',
    };
    await reconcile(assignment(agent()), {
      ...deps(),
      gatewayEnv: async (agentId, login) =>
        agentId === 'agent-1' && login.kind === 'api-key'
          ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41000', ANTHROPIC_API_KEY: 'swpg_opaque' }
          : null,
    });
    const launched = runtime.launches()[0]!;
    expect(launched.template.start.input.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:41000',
      ANTHROPIC_API_KEY: 'swpg_opaque',
    });
    expect(JSON.stringify(launched.template)).not.toContain('REAL');
    // Still in a process of its own, as any given login.
    expect(launched.options.isolation).toBe('isolated');
  });

  it('with the gateway on, a login it can’t front isn’t put in the environment at all', async () => {
    givenLogin = {
      status: 'connected',
      provider: 'claude',
      revision: '1',
      kind: 'setup-token',
      credential: 'sk-ant-oat01-GIVEN',
    };
    await reconcile(assignment(agent()), { ...deps(), gatewayEnv: async () => null });
    const env = runtime.launches()[0]!.template.start.input.env;
    expect(JSON.stringify(env)).not.toContain('sk-ant-oat01-GIVEN');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
