import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReasonedError } from './errors';
import { silentLogger } from './log';
import { dataLayout } from './paths';
import { definitionProblem, planReconcile, reconcile, type ReconcileDeps } from './reconcile';
import { emptyObservation, type HostedDeploymentRequest } from './runtime';
import type { AgentAssignment, Assignment, HostedDefinition } from './schemas';
import { mapAgentProcess } from './status';
import { ControllerStore } from './store';
import { SocketSupervisor } from './supervisor-client';
import { failureOf, SystemdRuntime } from './systemd-runtime';
import { FakeRuntime } from './testing/fake-runtime';

const AGENT = '00000000-0000-4000-8000-0000000000a2';

function hosted(overrides: Partial<HostedDefinition> = {}): HostedDefinition {
  return {
    machine_id: 'machine-1',
    launch_id: 'launch-1',
    launch_revision: 3,
    provider_credential_kind: 'setup-token',
    repository: 'example/project',
    spec: {
      name: 'cloud-helper',
      definition: '---\nname: cloud-helper\n---\nHelp.',
      instructions: 'Help.',
      definition_attributes: {},
      auto_session: true,
      auto_approve: false,
    },
    skills: [{ slug: 'github', files: { 'SKILL.md': '# GitHub\n' } }],
    worker_capability: 'worker-capability-placeholder-0123',
    ...overrides,
  };
}

function cloudAgent(
  overrides: Partial<AgentAssignment> = {},
  block: HostedDefinition | null = hosted()
): AgentAssignment {
  return {
    agent_id: AGENT,
    revision: 1,
    desired_state: 'running',
    definition: {
      name: 'cloud-helper',
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: 'sonnet',
      instructions: 'Help.',
      auto_session: true,
      auto_approve: false,
      directory: null,
      ...(block ? { hosted: block } : {}),
    },
    ...overrides,
  };
}

/** A machine supervisor on a unix socket: records each request, answers as scripted. */
class FakeSupervisor {
  readonly requests: Record<string, unknown>[] = [];
  answer: (request: Record<string, unknown>) => unknown = () => ({ ok: true });
  private server: Server | null = null;

  constructor(readonly path: string) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      let buffered = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        const request = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        this.requests.push(request);
        socket.end(`${JSON.stringify(this.answer(request))}\n`);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.path, resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

const RUNNING_UNIT = {
  installed: true,
  revision: 3,
  process_state: 'running',
  restarts: 1,
  oom_kills: 2,
  exit: null,
};

let dir: string;
let supervisor: FakeSupervisor;
let runtime: SystemdRuntime;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'systemd-runtime-'));
  supervisor = new FakeSupervisor(join(dir, 'supervisor.sock'));
  await supervisor.start();
  mkdirSync(join(dir, 'data'), { mode: 0o700 });
  mkdirSync(join(dir, 'agents'));
  runtime = new SystemdRuntime({
    layout: dataLayout(join(dir, 'data')),
    supervisor: new SocketSupervisor(supervisor.path),
    agentsDir: join(dir, 'agents'),
  });
});

afterEach(async () => {
  await supervisor.stop();
  rmSync(dir, { recursive: true, force: true });
});

function deployment(): HostedDeploymentRequest {
  return {
    launch_id: 'launch-1',
    agent_id: AGENT,
    name: 'cloud-helper',
    revision: 3,
    desired_state: 'running',
    provider: 'claude',
    provider_credential_kind: 'setup-token',
    worker_capability: 'worker-capability-placeholder-0123',
    switch_credentials: {
      env: {
        SWITCH_API_ENDPOINT: 'http://127.0.0.1:41000',
        SWITCH_API_TOKEN: 'swlr_placeholder',
        SWITCH_AGENT_ID: AGENT,
      },
    },
    repository: 'example/project',
    spec: hosted().spec,
    skills: hosted().skills,
  };
}

describe('SystemdRuntime', () => {
  it('asks the supervisor to install a deployment', async () => {
    await runtime.launchHosted(AGENT, deployment(), { restart: true });
    expect(supervisor.requests).toEqual([{ op: 'install', agent: deployment(), restart: true }]);
  });

  it('stops, removes and prunes through the supervisor', async () => {
    await runtime.stop(AGENT, { wait: false });
    await runtime.remove(AGENT);
    await runtime.prune([AGENT, 'not-an-agent-id']);
    expect(supervisor.requests).toEqual([
      { op: 'stop', agent_id: AGENT, wait: false },
      { op: 'remove', agent_id: AGENT },
      { op: 'prune', keep: [AGENT] },
    ]);
  });

  it('observes the unit as the supervisor reports it', async () => {
    supervisor.answer = () => ({ ok: true, unit: RUNNING_UNIT });
    const observation = await runtime.observe(AGENT);
    expect(supervisor.requests).toEqual([{ op: 'state', agent_id: AGENT }]);
    expect(observation.alive).toBe(true);
    expect(observation.failure).toBeNull();
    expect(observation.unit).toEqual({
      installed: true,
      revision: 3,
      processState: 'running',
      restarts: 1,
      oomKills: 2,
      exit: null,
    });
  });

  it('reads the watcher health from the agent state directory', async () => {
    supervisor.answer = () => ({ ok: true, unit: RUNNING_UNIT });
    mkdirSync(join(dir, 'agents', AGENT));
    writeFileSync(
      join(dir, 'agents', AGENT, 'health.json'),
      JSON.stringify({
        state: 'connected',
        detail: null,
        since: '2026-01-01T00:00:00.000Z',
        placements: { 'session-1': 'room-a' },
        pid: process.pid,
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const observation = await runtime.observe(AGENT);
    expect(observation.health?.state).toBe('connected');
    expect(observation.health?.placements).toEqual({ 'session-1': 'room-a' });
  });

  it('reports a unit that hit its restart limit as a failure that keeps it down', async () => {
    supervisor.answer = () => ({
      ok: true,
      unit: {
        ...RUNNING_UNIT,
        process_state: 'crashed',
        exit: { code: 1, signal: null, result: 'start-limit-hit' },
      },
    });
    const observation = await runtime.observe(AGENT);
    expect(observation.alive).toBe(false);
    expect(observation.failure).toMatch(/restart limit \(exit status 1, start-limit-hit\)/);
  });

  it('turns a refusal into a reasoned error', async () => {
    supervisor.answer = () => ({
      ok: false,
      error: { code: 'invalid_config', message: 'Provider credential kind None is invalid.' },
    });
    const refused = runtime.launchHosted(AGENT, deployment(), { restart: false });
    await expect(refused).rejects.toBeInstanceOf(ReasonedError);
    await expect(refused).rejects.toMatchObject({ reason: 'definition_invalid' });
  });

  it('refuses a watcher template and a working directory', async () => {
    await expect(runtime.workingDirectory()).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
  });

  it('fails clearly when the supervisor is not there', async () => {
    await supervisor.stop();
    await expect(runtime.stop(AGENT, { wait: false })).rejects.toThrow(/cannot be reached/);
  });

  it('keeps the relay credentials in its own data directory', async () => {
    await runtime.writeCredentials(AGENT, {
      endpoint: 'http://127.0.0.1:41000',
      token: 'swlr_x',
    });
    expect(await runtime.readCredentials(AGENT)).toEqual({
      endpoint: 'http://127.0.0.1:41000',
      token: 'swlr_x',
    });
  });
});

describe('an obsolete worker', () => {
  it('waits for its next revision rather than failing', () => {
    const exit = { code: 75, signal: null, result: 'exit-code' };
    const failure = failureOf('failed', exit);
    expect(failure).toMatch(/new revision/);
    expect(
      mapAgentProcess({
        assignment: cloudAgent(),
        row: {
          agentId: AGENT,
          appliedRevision: 1,
          changedAt: '2026-01-01T00:00:00Z',
          failure: null,
        },
        observation: {
          ...emptyObservation(),
          failure,
          unit: {
            installed: true,
            revision: 3,
            processState: 'failed',
            restarts: 0,
            oomKills: 0,
            exit,
          },
        },
        relayAttached: false,
        nowMs: 0,
      })
    ).toMatchObject({ process: 'pending', attached: false });
  });
});

describe('failureOf', () => {
  it('names nothing while the unit is not down for good', () => {
    expect(failureOf('running', null)).toBeNull();
    expect(failureOf('stopped', null)).toBeNull();
    expect(failureOf('failed', { code: null, signal: 9, result: 'oom-kill' })).toBe(
      "The agent's unit stopped with an error (signal 9, oom-kill)."
    );
  });
});

describe('cloud agents and runtimes', () => {
  it('runs a cloud agent only on a machine controller, and nothing else there', () => {
    expect(definitionProblem(cloudAgent(), 'systemd')).toBeNull();
    expect(definitionProblem(cloudAgent(), 'shared-host')).toMatch(/cloud agent/);
    expect(definitionProblem(cloudAgent({}, null), 'systemd')).toMatch(/cloud machine/);
  });

  it('holds a cloud agent whose launch is moving to a new revision', () => {
    const actions = planReconcile({
      assignment: {
        revision: 1,
        agents: [cloudAgent({}, hosted({ worker_capability: null }))],
      },
      rows: [],
      observations: new Map([[AGENT, emptyObservation()]]),
      credentialsChanged: new Set(),
      nowMs: 0,
      runtime: 'systemd',
    });
    expect(actions).toEqual([expect.objectContaining({ kind: 'hold', agentId: AGENT })]);
  });
});

describe('reconciling a cloud machine', () => {
  let fake: FakeRuntime;
  let store: ControllerStore;
  let clock: number;

  beforeEach(() => {
    fake = new FakeRuntime('systemd');
    store = ControllerStore.open(join(dir, 'controller.db'));
    clock = Date.parse('2026-01-01T00:00:00Z');
  });

  afterEach(() => store.close());

  function deps(): ReconcileDeps {
    return {
      store,
      runtime: fake,
      ensureCredentials: async (agentId) => {
        if (fake.credentials.has(agentId)) return false;
        await fake.writeCredentials(agentId, {
          endpoint: 'http://127.0.0.1:41000',
          token: 'swlr_relay',
        });
        return true;
      },
      forgetAgent: () => {},
      binaryPath: async () => {
        throw new Error('a cloud machine looks up no provider');
      },
      now: () => clock,
      log: silentLogger,
    };
  }

  const assignment = (...agents: AgentAssignment[]): Assignment => ({ revision: 1, agents });

  it('installs a cloud agent from its hosted block and its relay credentials', async () => {
    await reconcile(assignment(cloudAgent()), deps());
    const [call] = fake.calls.filter((c) => c.kind === 'launchHosted');
    expect(call).toEqual({
      kind: 'launchHosted',
      agentId: AGENT,
      deployment: {
        ...deployment(),
        switch_credentials: {
          env: {
            SWITCH_API_ENDPOINT: 'http://127.0.0.1:41000',
            SWITCH_API_TOKEN: 'swlr_relay',
            SWITCH_AGENT_ID: AGENT,
          },
        },
      },
      options: { restart: false },
    });
    expect(store.agent(AGENT)?.appliedRevision).toBe(1);
  });

  it('installs a stopped cloud agent stopped, and stops a running one', async () => {
    await reconcile(assignment(cloudAgent()), deps());
    await reconcile(assignment(cloudAgent({ revision: 2, desired_state: 'stopped' })), deps());
    expect(fake.calls.slice(-2)).toEqual([
      { kind: 'stop', agentId: AGENT, wait: false },
      { kind: 'prune', keep: [AGENT] },
    ]);
    expect(store.agent(AGENT)?.appliedRevision).toBe(2);
  });

  it('removes a cloud agent through the supervisor and deletes its relay token', async () => {
    await reconcile(assignment(cloudAgent()), deps());
    await reconcile(assignment(), deps());
    expect(fake.calls.slice(-3)).toEqual([
      { kind: 'remove', agentId: AGENT },
      { kind: 'deleteCredentials', agentId: AGENT },
      { kind: 'prune', keep: [] },
    ]);
  });

  it('tells the supervisor every agent it keeps after each pass', async () => {
    await reconcile(assignment(cloudAgent()), deps());
    expect(fake.calls.at(-1)).toEqual({ kind: 'prune', keep: [AGENT] });
  });

  it('installs again a unit that is gone without a failure, as after a reboot', async () => {
    await reconcile(assignment(cloudAgent()), deps());
    fake.kill(AGENT, null);
    clock += 60_000;
    await reconcile(assignment(cloudAgent()), deps());
    expect(fake.calls.filter((c) => c.kind === 'launchHosted')).toHaveLength(2);
  });

  it('records a refused install on the agent', async () => {
    fake.failNextLaunch = new ReasonedError('definition_invalid', 'bad deployment');
    await reconcile(assignment(cloudAgent()), deps());
    expect(store.agent(AGENT)?.failure).toMatchObject({
      reason: 'definition_invalid',
      detail: 'bad deployment',
    });
  });

  it('reports a crashed unit as a crash loop with its OOM kills', () => {
    const observation = {
      ...emptyObservation(),
      failure: 'kept failing',
      unit: {
        installed: true,
        revision: 3,
        processState: 'crashed' as const,
        restarts: 5,
        oomKills: 1,
        exit: { code: 1, signal: null, result: 'start-limit-hit' },
      },
    };
    expect(
      mapAgentProcess({
        assignment: cloudAgent(),
        row: {
          agentId: AGENT,
          appliedRevision: 1,
          changedAt: '2026-01-01T00:00:00Z',
          failure: null,
        },
        observation,
        relayAttached: false,
        nowMs: clock,
      })
    ).toEqual({
      process: 'crashed',
      attached: false,
      reason: 'crash_loop',
      detail: 'kept failing',
    });
  });
});
