import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentBridgeEvent } from '@sandboxaq/switch-agent-runtime';
import {
  generateSealingKeyPair,
  HUB_CLOSE,
  HUB_PROTOCOL,
  sealProviderLogin,
} from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  type ControllerDeps,
  type ControllerExit,
  ensureRelayCredentials,
  runController,
} from '../controller';
import { HostTickets } from '../host-tickets';
import { silentLogger } from '../log';
import { ProviderRechecks } from '../provider-rechecks';
import type { LocalRelay } from '../relay';
import type { AgentAssignment, StatusReport } from '../schemas';
import type { GivenLogin } from '../sealed-logins';
import { CONTROLLER_CREDENTIAL, FileSecretStore, SEALING_KEY } from '../secrets';
import { ControllerStore } from '../store';
import { FakeCore } from '../testing/fake-core';
import { FakeLocator, FakeRuntime } from '../testing/fake-runtime';
import { type BoxControllerDeps, frontable } from './controller-box';
import { VertexTokenCache } from './gateway-logins';
import { LauncherLink } from './launcher-link';
import { LauncherMeasure } from './launcher-measure';
import { encodeLine, type LauncherReport } from './launcher-protocol';
import { readLiveStatus } from './live-status';
import { LaunchGate, type ProbeEnv } from './split-runtime';

/**
 * The controller in box mode (`BoxController`): what only a hosted agents
 * box does. The same controller runs everywhere; desktop and v1 are
 * `controller.test.ts`, unchanged.
 */

function agent(revision: number, overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision,
    desired_state: 'running',
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
    },
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

let dir: string;
let core: FakeCore;
let store: ControllerStore;
let secrets: FileSecretStore;
let runtime: FakeRuntime;
let stop: AbortController;
let running: Promise<ControllerExit> | null;
let watchers: AbortController[];
let blockers: Server[];

function deps(server = core.url): ControllerDeps {
  store.saveIdentity({
    controllerId: core.controllerId,
    server,
    name: 'test-box',
    enrolledAt: '2026-01-01T00:00:00Z',
  });
  return {
    store,
    secrets,
    devicePolicy: null,
    runtime: runtime.build,
    locator: new FakeLocator(),
    rechecks: new ProviderRechecks(),
    refreshPath: async () => {},
    providerSeed: [],
    tools: async () => [],
    fetch,
    openWebSocket: core.openWebSocket,
    log: silentLogger,
    dataDir: dir,
    workspacesFor: () => join(dir, 'workspaces'),
    version: '0.1.0',
    deviceId: 'd'.repeat(64),
    updatedBy: 'self',
    selfUpdate: null,
    supervised: false,
    box: true,
    now: Date.now,
    random: () => 0,
    timing: {
      resyncMs: 60_000,
      statusPollMs: 20,
      statusMinGapMs: 10,
      defaultReportWithinS: 60,
      streamIdleMs: 2_000,
      streamInitialBackoffMs: 10,
      streamMaxBackoffMs: 50,
      streamSuspendedRetryMs: 30,
      eventBufferLimit: 100,
    },
  };
}

/** The controller in box mode, with these box-only deps. */
function boxDeps(extra: BoxControllerDeps = {}, server = core.url): ControllerDeps {
  return { ...deps(server), box: true, boxDeps: extra };
}

const quiet = { debug: () => {}, warn: () => {}, error: () => {} };

/** The agent's watcher, as the runtime runs it in the controller's process: its stream comes from the controller. */
function watcher(agentId = 'agent-1') {
  const events: AgentBridgeEvent[] = [];
  const controller = new AbortController();
  watchers.push(controller);
  const credentials = runtime.credentials.get(agentId)!;
  const stream = runtime.openStream!(agentId)({
    creds: { agentId, apiEndpoint: credentials.endpoint, token: credentials.token },
    connectionId: `controller-${agentId}`,
    scope: 'all',
    filter: 'addressed',
    spawnCapable: true,
    rooms: [],
    onEvent: (event) => void events.push(event),
    onGap: () => {},
    onEvicted: () => {},
    log: quiet,
    signal: controller.signal,
  });
  stream.start();
  return { stream, events };
}

function addressed(sequence: number) {
  return {
    type: 'message',
    room_id: 'room-a',
    bridge_id: null,
    channel_type: null,
    payload: {
      addressed: true,
      sender: '@person:example.org',
      sender_name: 'Person',
      message_id: `$m${sequence}`,
      body: 'hi',
      timestamp: sequence,
    },
    missed: { count: 0, reason: null },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function reportsFor(agentId: string): StatusReport['agents'] {
  return core.statusReports.flatMap((report) =>
    report.agents.filter((entry) => entry.agent_id === agentId)
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'controller-loop-'));
  core = new FakeCore();
  await core.start();
  store = ControllerStore.open(join(dir, 'controller.db'));
  secrets = new FileSecretStore(join(dir, 'secrets'));
  await secrets.set(CONTROLLER_CREDENTIAL, core.credential);
  runtime = new FakeRuntime();
  stop = new AbortController();
  running = null;
  watchers = [];
  blockers = [];
  core.rooms.set('agent-1', ['room-a']);
});

afterEach(async () => {
  for (const controller of watchers) controller.abort();
  for (const blocker of blockers) blocker.close();
  stop.abort();
  await running?.catch(() => {});
  await core.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runController in box mode', () => {
  it('writes the live status to the folder it is given, and never into the data folder', async () => {
    const liveDir = mkdtempSync(join(tmpdir(), 'live-status-dir-'));
    try {
      core.setAssignment({ revision: 1, agents: [agent(1)] });
      running = runController(boxDeps({ liveStatusDir: liveDir }), stop.signal);
      await waitFor(
        () => reportsFor('agent-1').some((entry) => entry.process === 'running'),
        'a status report with the agent running'
      );
      // Written from the status collected for Core, at most every 10 s.
      let read = await readLiveStatus(liveDir, Date.now());
      for (let tries = 0; tries < 150; tries++) {
        if (read.kind === 'fresh' && read.status.totals.process.running === 1) break;
        await delay(100);
        read = await readLiveStatus(liveDir, Date.now());
      }
      expect(read.kind === 'fresh' && read.status.totals.desired_running).toBe(1);
      expect(read.kind === 'fresh' && read.status.agents.map((entry) => entry.id)).toEqual([
        'agent-1',
      ]);
      expect(read.kind === 'fresh' && read.status.controller.assignment_revision).toBe(1);
      // Never in the data folder.
      expect(existsSync(join(dir, 'live-status.json'))).toBe(false);
    } finally {
      rmSync(liveDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('after a restart, starts its agent on the given login once a sign-in check that could not run at first succeeds', async () => {
    // The box wakes: its key is already saved, Switch already holds a login
    // sealed to it, and the agents container isn't linked yet, so the first
    // sign-in check of the given login can't run.
    const keys = generateSealingKeyPair();
    await secrets.set(SEALING_KEY, JSON.stringify(keys));
    core.sealedLogins.set('claude', {
      revision: 1,
      sealed: sealProviderLogin({
        publicKey: keys.publicKey,
        controllerId: core.controllerId,
        provider: 'claude',
        login: { kind: 'setup-token', credential: 'sk-ant-oat-given' },
      }),
    });
    runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
    runtime.loginReadiness = {
      status: 'unknown',
      message: 'The sign-in check did not run (not_connected).',
      models: [],
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(boxDeps({ uncheckedRetryMs: [100, 100, 100, 100] }), stop.signal);
    // Its first start can't use the login: there's no usable one yet.
    await waitFor(() => runtime.launches('agent-1').length >= 1, 'the first start');
    expect(runtime.launches('agent-1')[0]!.template.start.input.env).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN'
    );

    // The launcher links: a retry signs in, and the agent moves onto the login,
    // with no nudge or resync from Switch.
    runtime.loginReadiness = { status: 'authenticated', message: 'Signed in.', models: [] };
    await waitFor(
      () => runtime.credentials.get('agent-1')?.providerLogin?.revision === '1',
      'the agent on the given login',
      3_000
    );
    await waitFor(() => runtime.launches('agent-1').length >= 2, 'the agent moved onto it', 3_000);
    expect(runtime.launches('agent-1').at(-1)!.template.start.input.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-given',
    });
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('holds a login given while a turn runs, then restarts once, unasked, within a status poll of the turn ending', async () => {
    runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the first start');
    await waitFor(() => core.publicKey !== null, 'the machine registering its key');
    const health = runtime.observation('agent-1').health!;
    health.placements = { 'session-1': 'room-a' };
    health.busy = ['session-1'];

    core.sealedLogins.set('claude', {
      revision: 1,
      sealed: sealProviderLogin({
        publicKey: core.publicKey!,
        controllerId: core.controllerId,
        provider: 'claude',
        login: { kind: 'setup-token', credential: 'sk-ant-oat-given' },
      }),
    });
    core.addOperation({
      id: 'op-give',
      kind: 'provider.login',
      agent_id: null,
      params: { provider: 'claude', method: 'sealed', revision: 1 },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.push('operation.pending', {
      operation_id: 'op-give',
      kind: 'provider.login',
      agent_id: null,
    });
    await waitFor(() => core.results.has('op-give'), 'the login taken up');
    // Several status polls pass with the turn still running: no restart.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.launches('agent-1')).toHaveLength(1);

    // The turn ends. Nothing reported changes; the status poll brings it round.
    health.busy = [];
    // Status polls run every 20 ms here and the periodic report is a minute
    // off, so a restart inside a second came from a poll, not a report.
    await waitFor(() => runtime.launches('agent-1').length === 2, 'the owed restart', 1_000);
    expect(runtime.launches('agent-1')[1]!.options).toMatchObject({
      restart: true,
      asked: false,
      isolation: 'isolated',
    });
    // Paid once: later polls owe nothing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.launches('agent-1')).toHaveLength(2);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('rests a quiet agent, stopping its host, and starts it again for its next message', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(boxDeps({ restAfterMs: 50 }), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    watcher();
    const health = runtime.observation('agent-1').health!;
    health.sessions = { 'session-lead': 'parked' };
    health.busy = [];
    await waitFor(
      () => runtime.calls.some((call) => call.kind === 'stop' && call.agentId === 'agent-1'),
      'the quiet agent’s host stopped'
    );
    await waitFor(
      () => reportsFor('agent-1').some((entry) => entry.session === 'parked'),
      'reported resting'
    );
    expect(runtime.launches('agent-1')).toHaveLength(1);
    // The stopped host's stream goes with it, as a real host's does.
    watchers.at(-1)!.abort();
    // Its next message starts it again.
    core.pushEvent('agent-1', 1, addressed(1));
    await waitFor(() => runtime.launches('agent-1').length === 2, 'the agent woken');
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('withdraws a given login at once in box mode: its copy is forgotten and the host restarts without it', async () => {
    const keys = generateSealingKeyPair();
    await secrets.set(SEALING_KEY, JSON.stringify(keys));
    core.sealedLogins.set('claude', {
      revision: 1,
      sealed: sealProviderLogin({
        publicKey: keys.publicKey,
        controllerId: core.controllerId,
        provider: 'claude',
        login: { kind: 'setup-token', credential: 'sk-ant-oat-given' },
      }),
    });
    runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(boxDeps(), stop.signal);
    await waitFor(
      () => runtime.credentials.get('agent-1')?.providerLogin?.revision === '1',
      'the agent on the given login'
    );
    const launches = runtime.launches('agent-1').length;

    // Switch takes the login away; a recheck finds none.
    core.sealedLogins.delete('claude');
    core.addOperation({
      id: 'op-recheck',
      kind: 'provider.recheck',
      agent_id: null,
      params: { provider: 'claude' },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.push('operation.pending', {
      operation_id: 'op-recheck',
      kind: 'provider.recheck',
      agent_id: null,
    });
    await waitFor(
      () => runtime.calls.some((call) => call.kind === 'forgetProviderLogin'),
      'the login’s copy forgotten'
    );
    await waitFor(
      () => runtime.credentials.get('agent-1')?.providerLogin === null,
      'the credentials without the login'
    );
    await waitFor(() => runtime.launches('agent-1').length > launches, 'the host restarted');
    expect(runtime.launches('agent-1').at(-1)!.template.start.input.env).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN'
    );
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('ends as revoked, asking Switch nothing, when an earlier run was revoked and wiped its credential', async () => {
    const enrolled = deps();
    await secrets.delete(CONTROLLER_CREDENTIAL);
    store.markRevoked('2026-01-02T00:00:00Z');
    const before = core.requests.length;
    expect(await runController(enrolled, stop.signal)).toBe('revoked');
    expect(core.requests.length).toBe(before);
    expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBeNull();
    expect(store.identity()?.controllerId).toBe(core.controllerId);
    expect(store.revokedAt()).toBe('2026-01-02T00:00:00Z');
  });
});

describe("where an agent's sessions stand", () => {
  /**
   * Seen on a test box:
   * user-a-lead's session woke at 13:08:14 and answered in 3.3 s, but Switch
   * read every A agent as parked until 13:09:03, the next periodic report, and
   * never saw "waking". A change of session state alone has to send a report
   * within a status poll, as any other change does.
   */
  it('reports a session waking, then active, then parked, without waiting for the periodic report', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const health = runtime.observation('agent-1').health!;
    const sessionIn = (report: (typeof core.statusReports)[number] | undefined) =>
      report?.agents.find((a) => a.agent_id === 'agent-1')?.session;
    health.sessions = { 'session-lead': 'parked' };
    await waitFor(() => sessionIn(core.statusReports.at(-1)) === 'parked', 'parked reported');
    const launches = runtime.launches('agent-1').length;
    for (const state of ['waking', 'active', 'parked'] as const) {
      health.sessions = { 'session-lead': state };
      // The periodic report is a minute away (defaultReportWithinS: 60); a poll is 20 ms.
      await waitFor(() => sessionIn(core.statusReports.at(-1)) === state, `${state} reported`);
    }
    // A session changing state reports it; it does not start anything.
    expect(runtime.launches('agent-1').length).toBe(launches);
  });

  it('keeps a burst of session changes to one report per minimum gap', async () => {
    // A mass wake flips session states many times within a few seconds; each
    // poll that sees a change asks for a report, and statusMinGapMs (1 s in
    // production) spaces them out. Here the gap is 300 ms and the poll 20 ms.
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    const base = deps();
    running = runController(
      { ...base, timing: { ...base.timing, statusMinGapMs: 300 } },
      stop.signal
    );
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const health = runtime.observation('agent-1').health!;
    health.sessions = { 'session-lead': 'parked' };
    await waitFor(
      () => core.statusReports.at(-1)?.agents[0]?.session === 'parked',
      'parked reported'
    );
    await delay(350);
    const before = core.statusReports.length;
    const states = ['waking', 'active', 'parked'] as const;
    const started = Date.now();
    for (let i = 0; Date.now() - started < 900; i++) {
      health.sessions = { 'session-lead': states[i % 3]! };
      await delay(25);
    }
    // 900 ms of changes every 25 ms (36 changes) at one report per 300 ms is
    // at most 4 reports, not one per change.
    expect(core.statusReports.length - before).toBeLessThanOrEqual(4);
    expect(core.statusReports.length - before).toBeGreaterThanOrEqual(2);
  });
});

describe('ensureRelayCredentials in box mode', () => {
  function fakeRelay() {
    const registered = new Map<string, string>();
    let minted = 0;
    return {
      registered,
      relay: {
        endpoint: 'http://127.0.0.1:43210',
        hubUrl: 'ws://127.0.0.1:43210/hub',
        isRegistered: (agentId: string, token: string) => registered.get(agentId) === token,
        register: (agentId: string, token: string) => void registered.set(agentId, token),
        mint: (agentId: string) => {
          const token = `swlr_${++minted}`;
          registered.set(agentId, token);
          return token;
        },
      } as unknown as LocalRelay,
    };
  }

  it('says the relay changed, with a new token, when the relay moves to another port', async () => {
    const runtime = new FakeRuntime();
    const { relay, registered } = fakeRelay();
    const deps = { runtime, relay, log: silentLogger, box: {} };
    await ensureRelayCredentials('agent-1', null, deps);
    (relay as unknown as { endpoint: string }).endpoint = 'http://127.0.0.1:50000';
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe('relay');
    expect(registered.get('agent-1')).toBe('swlr_2');
  });
});

describe('runController on a split box', () => {
  it('listens for the launcher, admits one, says when it goes quiet or its container restarts, and closes with the controller', async () => {
    const said: string[] = [];
    const log = {
      ...silentLogger,
      info: (line: string) => void said.push(line),
      warn: (line: string) => void said.push(line),
      error: (line: string) => void said.push(line),
    };
    const socketPath = join(dir, 'launcher.sock');
    let clock = 0;
    const link = new LauncherLink({ socketPath, now: () => clock, log: () => {} });
    const split = {
      link,
      tickets: new HostTickets(),
      measure: new LauncherMeasure({ link, now: () => clock }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(() => clock),
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController({ ...boxDeps({ split }), log }, stop.signal);
    await waitFor(() => said.includes('Waiting for the launcher'), 'the controller waiting');

    const say = (socket: Socket, report: LauncherReport) => socket.write(encodeLine(report));
    const connectLauncher = async () => {
      const socket = connect(socketPath);
      await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
      return socket;
    };
    const first = await connectLauncher();
    const toLauncher: string[] = [];
    first.on('data', (chunk: Buffer) => void toLauncher.push(chunk.toString()));
    say(first, { kind: 'hello', version: '1', bundle: 'b', bootId: '1'.repeat(32) });
    // Told its settings at hello: operator exec off, as on any box not marked a test box.
    await waitFor(() => toLauncher.join('').includes('"kind":"settings"'), 'the settings order');
    expect(toLauncher.join('')).toContain('"operatorExec":false');
    say(first, { kind: 'measure', at: 1, agents: {} });
    await waitFor(() => link.current === 'live', 'the launcher live');
    // Silent past 6 s by the controller's clock: quiet, so nothing is admitted and idle sessions park.
    clock = 7_000;
    await waitFor(() => link.current === 'quiet', 'the launcher quiet', 3_000);
    expect(said).toContain('The launcher went quiet: admitting nothing, and parking idle sessions');
    first.destroy();
    await waitFor(() => link.current === 'lost', 'the launcher lost');
    expect(said).toContain('The launcher is lost: starting no agent until it is back');
    // Back with a new boot id: the agents container restarted.
    const second = await connectLauncher();
    say(second, { kind: 'hello', version: '1', bundle: 'b', bootId: '2'.repeat(32) });
    await waitFor(
      () =>
        said.includes(
          'The agents container restarted: every agent host is gone; looking at each again'
        ),
      'the restart noticed'
    );
    stop.abort();
    await running;
    running = null;
    // The controller's socket is gone with it.
    const refused = await new Promise<boolean>((resolve) => {
      const late = connect(socketPath);
      late.on('connect', () => resolve(false));
      late.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
    second.destroy();
  });
});

describe('runController on a split box that cannot listen for the launcher', () => {
  it('fails closed: one ERROR, reported unprotected, and tries the same address again until it can', async () => {
    const said: { level: string; line: string; fields?: unknown }[] = [];
    const log = {
      ...silentLogger,
      info: (line: string) => void said.push({ level: 'info', line }),
      warn: (line: string) => void said.push({ level: 'warn', line }),
      error: (line: string, fields?: unknown) => void said.push({ level: 'error', line, fields }),
    };
    // A folder that isn't there yet: the listener can't be opened.
    const folder = join(dir, 'not-yet');
    const socketPath = join(folder, 'launcher.sock');
    const link = new LauncherLink({ socketPath, now: Date.now, log: () => {} });
    const split = {
      link,
      tickets: new HostTickets(),
      measure: new LauncherMeasure({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
    };
    running = runController({ ...boxDeps({ split, launcherListenRetryMs: 50 }), log }, stop.signal);
    await waitFor(() => said.some((s) => s.level === 'error'), 'the one error');
    const errors = said.filter((s) => s.level === 'error');
    expect(errors).toEqual([
      {
        level: 'error',
        line: 'The controller could not listen for the launcher, so no agent can start on this box; it tries the same address again every 10 s',
        // ENOENT on Linux, EACCES under gVisor: a code, never the error's text.
        fields: { code: expect.stringMatching(/^E[A-Z]+$/) },
      },
    ]);
    await waitFor(
      () => core.statusReports.some((report) => report.machine?.valve_memory === 'unprotected'),
      'reported unprotected'
    );
    // Several retries later, still one ERROR.
    await delay(200);
    expect(said.filter((s) => s.level === 'error')).toHaveLength(1);
    // The folder appears: the same address now works, and the box recovers by itself.
    mkdirSync(folder);
    await waitFor(
      () => said.some((s) => s.line === 'The controller is listening for the launcher'),
      'listening again'
    );
    const reached = await new Promise<boolean>((resolve) => {
      const socket = connect(socketPath);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    expect(reached).toBe(true);
    stop.abort();
    await running;
    running = null;
  });
});

describe('runController on a split box on loopback, with the port taken first', () => {
  it('fails closed, sends the impostor nothing, and recovers by itself once the port is free', async () => {
    const said: { level: string; line: string }[] = [];
    const log = {
      ...silentLogger,
      info: (line: string) => void said.push({ level: 'info', line }),
      warn: (line: string) => void said.push({ level: 'warn', line }),
      error: (line: string) => void said.push({ level: 'error', line }),
    };
    const port = await freePort();
    // An agents-side process takes the port before the controller starts.
    const heardByImpostor: Buffer[] = [];
    const impostor = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => void heardByImpostor.push(chunk));
    });
    await new Promise<void>((resolve) => impostor.listen(port, '127.0.0.1', resolve));
    const link = new LauncherLink({
      address: { kind: 'loopback', port },
      now: Date.now,
      log: () => {},
    });
    const split = {
      link,
      tickets: new HostTickets(),
      measure: new LauncherMeasure({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController({ ...boxDeps({ split, launcherListenRetryMs: 50 }), log }, stop.signal);
    await waitFor(() => said.some((s) => s.level === 'error'), 'the one error');
    await waitFor(
      () => core.statusReports.some((report) => report.machine?.valve_memory === 'unprotected'),
      'reported unprotected'
    );
    // The controller never connects out: nothing at all reaches the impostor.
    await delay(200);
    expect(heardByImpostor).toEqual([]);
    expect(said.filter((s) => s.level === 'error')).toHaveLength(1);
    // The impostor goes; the controller takes the same port, and a launcher gets its settings.
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    await waitFor(
      () => said.some((s) => s.line === 'The controller is listening for the launcher'),
      'listening again'
    );
    const launcher = connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => launcher.on('connect', () => resolve()));
    const toLauncher: string[] = [];
    launcher.on('data', (chunk: Buffer) => void toLauncher.push(chunk.toString()));
    launcher.write(
      encodeLine({ kind: 'hello', version: '1', bundle: 'b', bootId: '3'.repeat(32) })
    );
    await waitFor(() => toLauncher.join('').includes('"kind":"settings"'), 'the settings order');
    launcher.destroy();
    stop.abort();
    await running;
    running = null;
  });
});

describe('runController on a split box: refused tickets', () => {
  it('relaunches after a refused ticket, and fails the agent after 3 spent ones, never for unknown ones', async () => {
    const said: string[] = [];
    const log = {
      ...silentLogger,
      warn: (line: string) => void said.push(line),
      error: (line: string) => void said.push(line),
    };
    const socketPath = join(dir, 'launcher.sock');
    const link = new LauncherLink({ socketPath, now: Date.now, log: () => {} });
    const tickets = new HostTickets();
    const gate = new LaunchGate(Date.now);
    const split = {
      link,
      tickets,
      measure: new LauncherMeasure({ link, now: Date.now }),
      runner: { launchOf: () => 1, currentLaunch: () => 1 },
      gate,
      operatorExec: true,
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController({ ...boxDeps({ split }), log }, stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const { hub, token } = runtime.credentials.get('agent-1')!;
    const hello = (ticket?: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(hub, { headers: { Authorization: `Bearer ${token}` } });
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              type: 'hello',
              protocol: HUB_PROTOCOL,
              startCursor: null,
              placements: {},
              ...(ticket ? { ticket } : {}),
            })
          )
        );
        ws.on('close', (code) => resolve(code));
        setTimeout(() => {
          resolve('open');
          ws.close();
        }, 300);
      });
    // Unknown tickets, however many: a relaunch with a backoff, never failed.
    for (let i = 0; i < 4; i++) expect(await hello('f'.repeat(32))).toBe(HUB_CLOSE.refused);
    expect(gate.isFailed('agent-1')).toBe(false);
    await waitFor(() => said.includes('Starting an agent’s host again'), 'a relaunch');
    // Three spent tickets in ten minutes: failed.
    for (let i = 0; i < 3; i++) {
      const ticket = tickets.mint('agent-1', 1);
      expect(await hello(ticket)).toBe('open');
      expect(await hello(ticket)).toBe(HUB_CLOSE.refused);
    }
    expect(gate.isFailed('agent-1')).toBe(true);
    expect(said).toContain(
      'An agent’s launch tickets kept being refused: it is failed until changed'
    );
    // Operator exec on (a test box): shown in the machine status.
    await waitFor(
      () => core.statusReports.some((report) => report.machine.operator_exec === true),
      'operator exec in the status'
    );
  });
});

describe('runController on a split box with the provider gateway', () => {
  it('reports the gateway’s counts and no daily cap, whatever an older assignment says', async () => {
    const socketPath = join(dir, 'launcher.sock');
    const link = new LauncherLink({ socketPath, now: Date.now, log: () => {} });
    const split = {
      link,
      tickets: new HostTickets(),
      measure: new LauncherMeasure({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
      setProbeEnv: () => {},
    };
    // An assignment from an older Switch that still names a workspace budget: ignored.
    core.setAssignment({ revision: 1, agents: [], gateway_daily_cap: 2 } as never);
    running = runController(boxDeps({ providerGateway: true, split }), stop.signal);
    await waitFor(
      () => core.statusReports.some((report) => report.machine.gateway_agents !== undefined),
      'a report with the gateway'
    );
    const reported = core.statusReports.at(-1)!.machine;
    for (const field of ['gateway_daily_cap', 'gateway_calls_today', 'gateway_capped'])
      expect(reported).not.toHaveProperty(field);
  });

  it('hands the gateway probe to the split runtime: a login check gets a swpg_ token, never the login', async () => {
    const socketPath = join(dir, 'launcher.sock');
    const link = new LauncherLink({ socketPath, now: Date.now, log: () => {} });
    let probeEnv: ProbeEnv | undefined;
    const split = {
      link,
      tickets: new HostTickets(),
      measure: new LauncherMeasure({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
      setProbeEnv: (given: ProbeEnv | undefined) => {
        probeEnv = given;
      },
    };
    core.setAssignment({ revision: 1, agents: [] });
    running = runController(boxDeps({ providerGateway: true, split }), stop.signal);
    await waitFor(() => probeEnv !== undefined, 'the gateway probe handed over');
    const login = {
      status: 'connected',
      provider: 'claude',
      revision: '1',
      kind: 'api-key',
      credential: 'sk-ant-api03-REAL-1',
    } as never;
    const probe = await probeEnv!('claude', login);
    expect(probe).not.toBeNull();
    expect(JSON.stringify(probe!.env)).not.toContain('REAL');
    expect(probe!.env.ANTHROPIC_API_KEY?.startsWith('swpg_')).toBe(true);
    probe!.done();
  });
});

describe('frontable', () => {
  it('takes as usable exactly the logins the gateway fronts', () => {
    const gateway = { vertex: new VertexTokenCache() };
    const codexSignIn = JSON.stringify({ tokens: { access_token: 'given-codex-sign-in' } });
    const given = (provider: 'claude' | 'codex', kind: GivenLogin['kind'], credential: string) =>
      ({ status: 'connected', provider, revision: '1', kind, credential }) as GivenLogin;
    expect(frontable(given('codex', 'auth-json', codexSignIn), gateway)).toBe(false);
    expect(frontable(given('codex', 'api-key', 'sk-openai'), gateway)).toBe(true);
    expect(frontable(given('claude', 'setup-token', 'sk-ant-oat'), gateway)).toBe(true);
    expect(frontable(given('claude', 'api-key', 'sk-ant-api'), gateway)).toBe(true);
    // Unreadable: left to the usual sign-in check, which says what is wrong.
    expect(frontable(given('claude', 'vertex', 'not json'), gateway)).toBe(true);
  });
});
