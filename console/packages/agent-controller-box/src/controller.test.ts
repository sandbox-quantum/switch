import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentBridgeEvent } from '@sandboxaq/switch-agent-runtime-box';
import {
  callOperation,
  SESSION_SELECTOR_HEADERS,
} from '@sandboxaq/switch-agent-runtime-box/hosted';
import {
  HUB_CLOSE,
  HUB_PROTOCOL,
  generateSealingKeyPair,
  openHubStream,
  sealProviderLogin,
} from '@switch-console/agent-providers-box';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  type ControllerDeps,
  type ControllerExit,
  ensureRelayCredentials,
  runController,
  valveSheddingHook,
} from './controller';
import { ConfigurationError } from './errors';
import { adoptIdentity } from './handover';
import { HostTickets } from './host-tickets';
import { LauncherGuard } from './launcher-guard';
import { LauncherLink } from './launcher-link';
import { encodeLine, type LauncherReport } from './launcher-protocol';
import { readLiveStatus } from './live-status';
import { silentLogger } from './log';
import { DEFAULT_LIMITS } from './memory-guard';
import { OwnerMarkers } from './owner-marker';
import { ProviderRechecks } from './provider-rechecks';
import type { LocalRelay } from './relay';
import type { AgentAssignment, StatusReport } from './schemas';
import { CONTROLLER_CREDENTIAL, FileSecretStore, MemorySecretStore, SEALING_KEY } from './secrets';
import { type ReleaseInstaller, SelfUpdater, type UpdateAttempt } from './self-update';
import { LaunchGate, type ProbeEnv } from './split-runtime';
import { ControllerStore } from './store';
import { buildWatcherTemplate } from './template';
import { FakeCore } from './testing/fake-core';
import { FakeLocator, FakeRuntime } from './testing/fake-runtime';

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
    runtime: runtime.build,
    locator: new FakeLocator(),
    rechecks: new ProviderRechecks(),
    refreshPath: async () => {},
    providerSeed: [],
    sessionStarted: () => {},
    tools: async () => [],
    fetch,
    openWebSocket: core.openWebSocket,
    log: silentLogger,
    dataDir: dir,
    workspacesFor: () => join(dir, 'workspaces'),
    version: '0.1.0',
    updatedBy: 'self',
    selfUpdate: null,
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
      eventBufferLimit: 100,
    },
  };
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

/** What the watcher of `agent(1)` was launched from. */
function runtimeTemplate() {
  return buildWatcherTemplate({
    agentId: 'agent-1',
    provider: 'claude',
    definition: agent(1).definition,
    cwd: '/data/workspaces/scout',
    credentialsPath: '/data/agents/agent-1/credentials.json',
    binaryPath: '/usr/bin/claude',
  });
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

describe('runController', () => {
  it('starts the agent pointed at its relay, relays its events, confirms them upstream, and exits when revoked', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);

    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const credentials = runtime.credentials.get('agent-1')!;
    expect(credentials.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(credentials.token).toMatch(/^swlr_/);
    expect(store.relayPort()).toBe(Number(new URL(credentials.endpoint).port));
    // Nothing assigned yet when the stream first opened: every agent starts at head.
    expect(core.opens[0]).toEqual({});

    const { events } = watcher();
    await waitFor(
      () => reportsFor('agent-1').some((entry) => entry.process === 'running' && entry.attached),
      'a status report with the agent attached'
    );
    core.pushEvent('agent-1', 1, addressed(1));
    await waitFor(() => events.length === 1, 'the event at the watcher');
    expect(events[0]).toMatchObject({ type: 'message', room_id: 'room-a', sequence: 1 });
    await waitFor(
      () => core.beats.some((beat) => beat['agent-1'] === 1),
      'the watcher’s confirmation beaten upstream'
    );
    expect(store.cursors().get('agent-1')).toBe(1);

    const forwarded = await callOperation(
      {
        identity: { endpoint: credentials.endpoint, agentId: 'agent-1', token: credentials.token },
        connectionId: 'controller-agent-1',
        selector: { [SESSION_SELECTOR_HEADERS.sessionId]: 'session-1' },
        room: null,
        mediaDir: dir,
        cwd: dir,
        deadConnection: () => 'dead',
      },
      'post_message',
      { body: 'hello' }
    );
    expect(forwarded.isError).toBeFalsy();
    const op = core.requests.findLast((r) => r.path === '/agents/agent-1/ops/post_message')!;
    expect(op.headers['x-switch-agent-id']).toBe('agent-1');
    expect(op.headers.authorization).toMatch(/^Bearer access-token-/);

    core.revoke();
    expect(await running).toBe('revoked');
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        { kind: 'stop', agentId: 'agent-1', wait: false },
        { kind: 'deleteCredentials', agentId: 'agent-1' },
      ])
    );
    expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBeNull();
    expect(store.revokedAt()).not.toBeNull();
    expect(runtime.closed).toBe(true);
    await expect(fetch(`${credentials.endpoint}/version`)).rejects.toThrow();
  }, 20_000);

  it('writes the live status to the folder it is given, and never into the data folder', async () => {
    const liveDir = mkdtempSync(join(tmpdir(), 'live-status-dir-'));
    try {
      core.setAssignment({ revision: 1, agents: [agent(1)] });
      running = runController({ ...deps(), liveStatusDir: liveDir }, stop.signal);
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

  it('serves an isolated agent its events on the hub over the relay, and moves it in-process when that changes', async () => {
    const isolatedAgent = agent(1);
    isolatedAgent.definition.isolation = 'isolated';
    core.setAssignment({ revision: 1, agents: [isolatedAgent] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    expect(runtime.launches('agent-1')[0]!.options.isolation).toBe('isolated');
    const credentials = runtime.credentials.get('agent-1')!;
    const events: AgentBridgeEvent[] = [];
    const own = new AbortController();
    watchers.push(own);
    openHubStream(credentials.hub)({
      creds: { agentId: 'agent-1', apiEndpoint: credentials.endpoint, token: credentials.token },
      connectionId: 'isolated-host',
      scope: 'all',
      filter: 'addressed',
      rooms: [],
      onEvent: (event) => void events.push(event),
      onGap: () => {},
      onEvicted: () => {},
      log: quiet,
      signal: own.signal,
    }).start();
    await waitFor(
      () => reportsFor('agent-1').at(-1)?.attached === true,
      'the isolated host attached'
    );
    core.pushEvent('agent-1', 1, addressed(1));
    await waitFor(() => events.length === 1, 'the event on the hub');
    await waitFor(() => store.cursors().get('agent-1') === 1, 'its cursor confirmed');

    core.setAssignment({ revision: 2, agents: [agent(2)] });
    core.push('assignment.changed', { revision: 2 });
    await waitFor(() => runtime.launches('agent-1').length === 2, 'a restart in-process');
    expect(runtime.launches('agent-1')[1]!.options.isolation).toBe('shared');
    const { events: inProcess } = watcher();
    core.pushEvent('agent-1', 2, addressed(2));
    await waitFor(() => inProcess.length === 1, 'the next event at the host in the controller');
    expect(inProcess[0]!.sequence).toBe(2);
    expect(events).toHaveLength(1);
    stop.abort();
    expect(await running).toBe('stopped');
  }, 20_000);

  it('reopens the stream with the confirmed cursors, and follows attach and detach live', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const { stream, events } = watcher();
    await waitFor(() => reportsFor('agent-1').at(-1)?.attached === true, 'the watcher attached');
    core.pushEvent('agent-1', 5, addressed(5));
    await waitFor(() => events.length === 1, 'the event');
    await waitFor(() => store.cursors().get('agent-1') === 5, 'the cursor confirmed');

    await stream.replacePlacements({ 'session-1': 'room-a' });

    core.forgetConnection();
    await waitFor(() => core.opens.length === 2, 'a new connection');
    expect(core.opens[1]).toEqual({ 'agent-1': 5 });
    await waitFor(() => core.streamCount === 1, 'the new stream attached');
    core.pushEvent('agent-1', 6, addressed(6));
    await waitFor(() => events.length === 2, 'the next event, once');
    expect(events.map((event) => event.sequence)).toEqual([5, 6]);

    await waitFor(() => reportsFor('agent-1').at(-1)?.attached === true, 'attached');
    core.push('agent.detached', { agent_id: 'agent-1', reason: 'unassigned' });
    await waitFor(() => reportsFor('agent-1').at(-1)?.attached === false, 'detached');
    core.push('agent.attached', { agent_id: 'agent-1', from_seq: 6, rooms: ['room-a'] });
    await waitFor(() => reportsFor('agent-1').at(-1)?.attached === true, 'attached again');

    core.setAssignment({ revision: 2, agents: [agent(2)] });
    core.assignment.agents[0]!.definition.model = 'opus';
    core.push('assignment.changed', { revision: 2 });
    await waitFor(
      () => runtime.launches('agent-1').length === 2,
      'the new revision handed to the agent host'
    );
    expect(runtime.launches('agent-1')[1]!.options.restart).toBe(false);
    expect(runtime.launches('agent-1')[1]!.template.start.input.model).toEqual({ id: 'opus' });
    stop.abort();
    expect(await running).toBe('stopped');
  }, 20_000);

  it('restarts an agent host whose credentials predate the hub, so it comes back on the hub', async () => {
    const port = await freePort();
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    store.saveRelayPort(port);
    store.saveAssignment(core.assignment, '"1"', '2026-01-01T00:00:00Z');
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    await runtime.launch('agent-1', runtimeTemplate(), {
      isolation: 'isolated',
      restart: false,
      replaceIdentity: false,
      clearTakenOver: false,
    });
    // As a controller from before the hub wrote them: the relay and a token, no hub.
    await runtime.writeCredentials('agent-1', {
      endpoint: `http://127.0.0.1:${port}`,
      token: 'swlr_old',
      hub: '',
      providerLogin: null,
    });
    runtime.calls.length = 0;
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'a restart');
    expect(runtime.launches('agent-1')[0]!.options.restart).toBe(true);
    expect(runtime.credentials.get('agent-1')).toMatchObject({
      endpoint: `http://127.0.0.1:${port}`,
      hub: `ws://127.0.0.1:${port}/hub`,
    });
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('points a watcher at the relay’s new port, and restarts it, when its old one is taken', async () => {
    const port = await freePort();
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    store.saveRelayPort(port);
    store.saveAssignment(core.assignment, '"1"', '2026-01-01T00:00:00Z');
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    await runtime.launch('agent-1', runtimeTemplate(), {
      isolation: 'shared',
      restart: false,
      replaceIdentity: false,
      clearTakenOver: false,
    });
    await runtime.writeCredentials('agent-1', {
      endpoint: `http://127.0.0.1:${port}`,
      token: 'swlr_old',
      hub: `ws://127.0.0.1:${port}/hub`,
      providerLogin: null,
    });
    runtime.calls.length = 0;
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'a restart');
    expect(runtime.launches('agent-1')[0]!.options.restart).toBe(true);
    expect(runtime.credentials.get('agent-1')!.endpoint).not.toBe(`http://127.0.0.1:${port}`);
    expect(store.relayPort()).not.toBe(port);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('exits as taken over when another instance opens the controller stream', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => core.streamCount === 1, 'the controller stream');
    const token = await (
      await fetch(`${core.url}/v1/management/controllers/${core.controllerId}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: core.credential }),
      })
    ).json();
    await fetch(`${core.url}/v1/controllers/${core.controllerId}/connection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ client: 'other', client_version: '0', cursors: {} }),
    });
    expect(await running).toBe('taken_over');
    expect(runtime.calls.filter((call) => call.kind === 'stop')).toEqual([]);
  });

  it('checks every provider again on request, with a fresh PATH, and reports it before answering', async () => {
    const locator = new FakeLocator();
    locator.missing.add('codex');
    const rechecks = new ProviderRechecks();
    let pathRefreshes = 0;
    core.setAssignment({ revision: 1, agents: [] });
    running = runController(
      {
        ...deps(),
        locator,
        rechecks,
        refreshPath: async () => {
          pathRefreshes += 1;
        },
      },
      stop.signal
    );
    const codexIn = (report: StatusReport | undefined) =>
      report?.providers.find((entry) => entry.provider === 'codex')?.installed;
    await waitFor(() => codexIn(core.statusReports.at(-1)) === false, 'codex reported missing');

    // Installed since: only a recheck finds it before the check goes stale.
    locator.missing.delete('codex');
    await rechecks.run();

    expect(pathRefreshes).toBe(1);
    expect(codexIn(core.statusReports.at(-1))).toBe(true);
  });

  it('refuses a recheck while the controller is not running', async () => {
    await expect(new ProviderRechecks().run()).rejects.toThrow(/not connected/);
  });

  it('runs pending operations when nudged', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the first start');
    const probesBefore = runtime.probes;
    core.addOperation({
      id: 'op-restart',
      kind: 'agent.restart',
      agent_id: 'agent-1',
      params: {},
      created_at: '2026-01-01T00:00:00Z',
    });
    core.addOperation({
      id: 'op-recheck',
      kind: 'provider.recheck',
      agent_id: null,
      params: { provider: 'claude' },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.addOperation({
      id: 'op-login',
      kind: 'provider.login',
      agent_id: null,
      params: { provider: 'claude', method: 'device_code' },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.push('operation.pending', {
      operation_id: 'op-restart',
      kind: 'agent.restart',
      agent_id: 'agent-1',
    });
    await waitFor(() => core.results.size === 3, 'three operation results');
    expect(core.results.get('op-restart')).toEqual({ outcome: 'succeeded' });
    expect(core.results.get('op-recheck')).toMatchObject({ outcome: 'succeeded' });
    expect(core.results.get('op-login')).toMatchObject({
      outcome: 'failed',
      error: { code: 'operation_unsupported' },
    });
    expect(runtime.launches('agent-1')).toHaveLength(2);
    expect(runtime.launches('agent-1')[1]!.options).toMatchObject({
      restart: true,
      clearTakenOver: true,
    });
    expect(runtime.probes).toBeGreaterThan(probesBefore);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('warms the agent host for a room when Switch asks, and only warns when it cannot', async () => {
    const warnings: string[] = [];
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(
      { ...deps(), log: { ...silentLogger, warn: (message) => void warnings.push(message) } },
      stop.signal
    );
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    await waitFor(() => core.streamCount === 1, 'the stream attached');

    runtime.warmFailure = new Error('not running here');
    core.push('agent.warm', { agent_id: 'agent-1', room_id: 'room-a' });
    await waitFor(() => warnings.some((w) => w.includes('warm')), 'the warning');

    runtime.warmFailure = null;
    core.push('agent.warm', { agent_id: 'agent-1', room_id: 'room-a' });
    await waitFor(() => runtime.warms.length === 1, 'the warm');
    expect(runtime.warms).toEqual([{ agentId: 'agent-1', roomId: 'room-a' }]);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('takes up a login given to the machine on demand, and moves its agent onto it', async () => {
    runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the first start');
    await waitFor(() => core.publicKey !== null, 'the machine registering its key');
    expect(runtime.launches('agent-1')[0]!.options.isolation).toBe('shared');
    expect(runtime.credentials.get('agent-1')?.providerLogin).toBeNull();

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
    expect(core.results.get('op-give')).toMatchObject({
      outcome: 'succeeded',
      output: { provider: { auth: 'ok', auth_source: 'sealed' } },
    });
    await waitFor(() => runtime.launches('agent-1').length === 2, 'the agent moved onto it');
    const moved = runtime.launches('agent-1')[1]!;
    expect(moved.options).toMatchObject({ isolation: 'isolated', restart: true });
    expect(moved.template.start.input.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-given',
    });
    expect(runtime.credentials.get('agent-1')?.providerLogin).toMatchObject({
      provider: 'claude',
      revision: '1',
    });
    await waitFor(
      () =>
        core.statusReports.some(
          (report) =>
            report.providers.find((entry) => entry.provider === 'claude')?.auth_source === 'sealed'
        ),
      'a status report saying Claude is ready through the given login'
    );
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('after a restart, starts its agent on the given login once a sign-in check that could not run at first succeeds (wake defect, 1 Nov)', async () => {
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
    const base = deps();
    running = runController(
      { ...base, timing: { ...base.timing, uncheckedRetryMs: [100, 100, 100, 100] } },
      stop.signal
    );
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

  it('resyncs after the stream drops and reconnects', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the first start');
    core.setAssignment({ revision: 2, agents: [agent(2)] });
    core.closeStreams();
    await waitFor(() => runtime.launches('agent-1').length === 2, 'a resync on reconnect');
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('reconciles the cached assignment while the server is unreachable', async () => {
    store.saveAssignment({ revision: 1, agents: [agent(1)] }, '"1"', '2026-01-01T00:00:00Z');
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    await runtime.writeCredentials('agent-1', {
      endpoint: 'http://127.0.0.1:1',
      token: 'swlr_k',
      hub: 'ws://127.0.0.1:1/hub',
      providerLogin: null,
    });
    runtime.calls.length = 0;
    await core.stop();
    running = runController(deps('http://127.0.0.1:1'), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent restored from cache');
    expect(runtime.launches('agent-1')[0]!.options.restart).toBe(false);
    expect(runtime.credentials.get('agent-1')!.endpoint).not.toBe('http://127.0.0.1:1');
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('keeps an agent the memory guard stopped held across a restart, and starts one it released', async () => {
    store.saveAssignment(
      { revision: 1, agents: [agent(1), agent(1, { agent_id: 'agent-2' })] },
      '"1"',
      '2026-01-01T00:00:00Z'
    );
    for (const agentId of ['agent-1', 'agent-2']) {
      store.recordApplied(agentId, 1, '2026-01-01T00:00:00Z');
      await runtime.writeCredentials(agentId, {
        endpoint: 'http://127.0.0.1:1',
        token: 'swlr_k',
        hub: 'ws://127.0.0.1:1/hub',
        providerLogin: null,
      });
    }
    // agent-1 was stopped by the guard and has had no message since;
    // agent-2's next message woke it before the restart.
    const record = (held: boolean) =>
      JSON.stringify({
        count: 1,
        held,
        last: {
          at: '2026-01-01T00:00:00.000Z',
          bytes: 4_000_000_000,
          limit: 3_865_470_566,
          percent: 60,
          trigger: 'share',
        },
      });
    for (const [agentId, held] of [
      ['agent-1', true],
      ['agent-2', false],
    ] as const) {
      mkdirSync(join(dir, 'agents', agentId), { recursive: true });
      writeFileSync(join(dir, 'agents', agentId, 'guard-stop.json'), record(held));
    }
    runtime.calls.length = 0;
    await core.stop();
    running = runController(deps('http://127.0.0.1:1'), stop.signal);
    await waitFor(() => runtime.launches('agent-2').length === 1, 'the released agent started');
    await delay(200);
    expect(runtime.launches('agent-1')).toEqual([]);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('says the memory guard is on, with its limit, once it starts', async () => {
    store.saveAssignment({ revision: 1, agents: [agent(1)] }, '"1"', '2026-01-01T00:00:00Z');
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    await core.stop();
    const lines: string[] = [];
    const log = { ...silentLogger, info: (message: string) => void lines.push(message) };
    running = runController(
      {
        ...deps('http://127.0.0.1:1'),
        log,
        memoryGuard: {
          markers: new OwnerMarkers(Buffer.alloc(32, 1)),
          limits: { ...DEFAULT_LIMITS, boxLimit: 6 * 1024 ** 3 },
        },
      },
      stop.signal
    );
    await waitFor(() => lines.includes('Memory guard on'), 'the guard-on line');
    stop.abort();
    expect(await running).toBe('stopped');
    expect(lines.filter((line) => line === 'Memory guard on')).toHaveLength(1);
  });

  it('says nothing about a guard when none is configured', async () => {
    store.saveAssignment({ revision: 1, agents: [agent(1)] }, '"1"', '2026-01-01T00:00:00Z');
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    await core.stop();
    const lines: string[] = [];
    const log = { ...silentLogger, info: (message: string) => void lines.push(message) };
    running = runController({ ...deps('http://127.0.0.1:1'), log }, stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    stop.abort();
    expect(await running).toBe('stopped');
    expect(lines).not.toContain('Memory guard on');
  });

  it('exits as revoked when the credential exchange is refused as revoked', async () => {
    core.revoked = true;
    running = runController(deps(), stop.signal);
    expect(await running).toBe('revoked');
    expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

  // Switch with hosted agents switched off refuses a box controller with a 403
  // while the box is still up. That is not a revocation: the controller keeps
  // its identity and credential and tries again, so the box resumes with its
  // data when hosted agents come back on. Exiting 3 or 6 here would have the
  // box's entrypoint retire the identity and enrol a new one.
  for (const code of ['hosted_v2_off', 'forbidden']) {
    it(`keeps its identity and retries when the token exchange is refused 403 ${code}`, async () => {
      core.forbidden = code;
      running = runController(deps(), stop.signal);
      const ending = running.then(String, () => 'threw');
      await waitFor(
        () => core.requests.filter((request) => request.path.endsWith('/token')).length >= 2,
        'the token exchange tried again'
      );
      core.forbidden = null;
      await waitFor(() => core.streamCount === 1, 'the stream back once Switch takes it again');
      stop.abort();
      expect(await ending).toBe('stopped');
      expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBe(core.credential);
      expect(store.identity()?.controllerId).toBe(core.controllerId);
    });

    it(`keeps its identity and reconnects when the stream is refused 403 ${code}`, async () => {
      running = runController(deps(), stop.signal);
      await waitFor(() => core.streamCount === 1, 'the stream up');
      core.forbidden = code;
      core.closeStreams();
      const before = core.requests.length;
      await waitFor(() => core.requests.length >= before + 3, 'reconnects refused');
      expect(core.streamCount).toBe(0);
      core.forbidden = null;
      await waitFor(() => core.streamCount === 1, 'the stream back');
      stop.abort();
      expect(await running).toBe('stopped');
      expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBe(core.credential);
      expect(store.identity()?.controllerId).toBe(core.controllerId);
    });
  }

  it('runs on an adopted identity with the credential in memory, and writes it nowhere', async () => {
    const handedDir = mkdtempSync(join(tmpdir(), 'controller-handed-'));
    const handed = ControllerStore.open(join(handedDir, 'controller.db'));
    try {
      adoptIdentity(
        handed,
        {
          controllerId: core.controllerId,
          server: core.url,
          name: 'console-box',
          now: new Date('2026-01-01T00:00:00Z'),
        },
        handedDir
      );
      const memory = new MemorySecretStore(
        { [CONTROLLER_CREDENTIAL]: core.credential },
        'handed over on stdin'
      );
      core.setAssignment({ revision: 1, agents: [agent(1)] });
      running = runController(
        { ...deps(), store: handed, secrets: memory, dataDir: handedDir },
        stop.signal
      );
      await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
      core.revoke();
      expect(await running).toBe('revoked');
      expect(await memory.get(CONTROLLER_CREDENTIAL)).toBeNull();
      expect(handed.revokedAt()).not.toBeNull();
      expect(existsSync(join(handedDir, 'secrets'))).toBe(false);
      for (const name of readdirSync(handedDir))
        if (!name.startsWith('controller.db'))
          throw new Error(`The controller wrote ${name} into its data directory.`);
      for (const name of readdirSync(handedDir))
        expect(readFileSync(join(handedDir, name)).includes(core.credential)).toBe(false);
    } finally {
      handed.close();
      rmSync(handedDir, { recursive: true, force: true });
    }
  });

  it('runs against the server URL its parent moved it to', async () => {
    const moved = deps('https://old-address.example.com');
    expect(
      adoptIdentity(
        store,
        { controllerId: core.controllerId, server: core.url, name: 'test-box', now: new Date() },
        dir
      )
    ).toBe('server_changed');
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(moved, stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    expect(store.identity()?.server).toBe(core.url);
  });

  it('refuses to run without an identity or a credential', async () => {
    const empty = ControllerStore.open(join(dir, 'empty.db'));
    try {
      const unenrolled = runController({ ...deps(), store: empty }, stop.signal);
      await expect(unenrolled).rejects.toThrow(/not enrolled/);
      await expect(unenrolled).rejects.toBeInstanceOf(ConfigurationError);
    } finally {
      empty.close();
    }
    const enrolled = deps();
    await secrets.delete(CONTROLLER_CREDENTIAL);
    const missing = runController(enrolled, stop.signal);
    await expect(missing).rejects.toThrow(/credential is missing/);
    await expect(missing).rejects.toBeInstanceOf(ConfigurationError);
  });

  // A pause revoked the controller and that run wiped its credential. A
  // later start (the box woken after the resume) ends as revoked again, exit 3,
  // so the box's entrypoint enrols afresh with its new code. It asks Switch
  // nothing and keeps the identity, which the entrypoint moves aside.
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

  it('refuses to run with a daily call cap that isn’t a whole number, so a typo never means no cap', async () => {
    const capped = runController(
      { ...deps(), providerGateway: true, providerGatewayDailyCalls: '5k' },
      stop.signal
    );
    await expect(capped).rejects.toThrow(/SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS/);
    await expect(capped).rejects.toBeInstanceOf(ConfigurationError);
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

describe('the release Switch names', () => {
  function selfUpdate() {
    const installed: string[] = [];
    const installer: ReleaseInstaller = {
      unavailable: null,
      prepare: async () => {},
      activate: async (version) => void installed.push(version),
    };
    let attempt: UpdateAttempt | null = null;
    const updater = new SelfUpdater({
      version: '0.1.0',
      installer,
      download: async () => join(dir, 'never-written.tgz'),
      attempts: { last: () => attempt, save: (saved) => void (attempt = saved) },
      supervised: true,
      log: silentLogger,
      now: Date.now,
    });
    return { updater, installed };
  }

  const release = {
    version: '0.2.0',
    url: 'https://example.invalid/switch-agent-controller-0.2.0.tgz',
    sha256: 'c'.repeat(64),
  };

  it('is installed while no session is mid-turn, and the controller ends to restart on it', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    core.controllerRelease = release;
    const { updater, installed } = selfUpdate();
    running = runController({ ...deps(), selfUpdate: updater }, stop.signal);
    expect(await running).toBe('restarting');
    expect(installed).toEqual(['0.2.0']);
  });

  it('waits while an agent host that does not report busy sessions has any, and says so in the status', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    const { updater, installed } = selfUpdate();
    running = runController({ ...deps(), selfUpdate: updater }, stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    runtime.observation('agent-1').health!.placements = { 'session-1': 'room-a' };
    core.controllerRelease = release;
    await waitFor(
      () => core.statusReports.some((report) => report.update?.state === 'waiting_idle'),
      'a status saying the update waits'
    );
    expect(core.statusReports.at(-1)?.update).toEqual({ target: '0.2.0', state: 'waiting_idle' });
    expect(installed).toEqual([]);
    runtime.observation('agent-1').health!.placements = {};
    expect(await running).toBe('restarting');
    expect(installed).toEqual(['0.2.0']);
  });

  it('waits only while a session is mid-turn when the agent host says which are', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    const { updater, installed } = selfUpdate();
    running = runController({ ...deps(), selfUpdate: updater }, stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const health = runtime.observation('agent-1').health!;
    health.placements = { 'session-1': 'room-a', 'session-2': 'room-b' };
    health.busy = ['session-1'];
    core.controllerRelease = release;
    await waitFor(
      () => core.statusReports.some((report) => report.update?.state === 'waiting_idle'),
      'a status saying the update waits'
    );
    expect(installed).toEqual([]);
    health.busy = [];
    expect(await running).toBe('restarting');
    expect(installed).toEqual(['0.2.0']);
  });

  it('is left alone by a controller that does not update itself', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    core.controllerRelease = release;
    running = runController(deps(), stop.signal);
    await waitFor(() => core.statusReports.length >= 2, 'two status reports');
    expect(core.statusReports.every((report) => report.update === undefined)).toBe(true);
    stop.abort();
    expect(await running).toBe('stopped');
  });
});

describe('an agent host that outlived the controller on another bundle', () => {
  const restarts = () =>
    runtime.launches('agent-1').filter((call) => call.options.restart === true);

  it('is restarted onto this controller’s bundle once none of its sessions is mid-turn, and only once', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    const observation = runtime.observation('agent-1');
    observation.outdated = true;
    observation.health!.placements = { 'session-1': 'room-a' };
    observation.health!.busy = ['session-1'];
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restarts()).toEqual([]);

    observation.health!.busy = [];
    await waitFor(() => restarts().length === 1, 'the outdated agent host restarted');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restarts()).toHaveLength(1);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('is not restarted again while it stays on another bundle, within the retry wait', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    runtime.observation('agent-1').outdated = true;
    await waitFor(() => restarts().length === 1, 'the outdated agent host restarted');
    runtime.observation('agent-1').outdated = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restarts()).toHaveLength(1);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('is left alone when it runs this controller’s bundle', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent started');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(restarts()).toEqual([]);
    stop.abort();
    expect(await running).toBe('stopped');
  });
});

describe('ensureRelayCredentials', () => {
  const login = {
    status: 'connected' as const,
    provider: 'claude' as const,
    revision: '1',
    kind: 'setup-token' as const,
    credential: 'sk-ant-oat-given',
  };

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

  it('rewrites the file, keeping its token, when the given login changes', async () => {
    const runtime = new FakeRuntime();
    const { relay } = fakeRelay();
    const deps = { runtime, relay, log: silentLogger };
    // None yet: written with a new token, so a running host (there is none) would be cut off.
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe('relay');
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe(false);
    // Only the login: the relay keeps taking the old token (a busy host may finish its turn).
    expect(await ensureRelayCredentials('agent-1', login, deps)).toBe('login');
    expect(runtime.credentials.get('agent-1')).toMatchObject({
      token: 'swlr_1',
      providerLogin: login,
    });
    expect(await ensureRelayCredentials('agent-1', login, deps)).toBe(false);
    // The same login with its fields in another order is the same login.
    const reordered = {
      credential: login.credential,
      kind: login.kind,
      revision: login.revision,
      provider: login.provider,
      status: login.status,
    };
    expect(await ensureRelayCredentials('agent-1', reordered, deps)).toBe(false);
    expect(await ensureRelayCredentials('agent-1', { ...login, revision: '2' }, deps)).toBe(
      'login'
    );
    // Withdrawn, not changed: it must not wait for a turn to finish.
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe('withdrawn');
    expect(runtime.credentials.get('agent-1')).toMatchObject({
      token: 'swlr_1',
      providerLogin: null,
    });
  });

  it('says the relay changed, with a new token, when the relay moves to another port', async () => {
    const runtime = new FakeRuntime();
    const { relay, registered } = fakeRelay();
    const deps = { runtime, relay, log: silentLogger };
    await ensureRelayCredentials('agent-1', null, deps);
    (relay as unknown as { endpoint: string }).endpoint = 'http://127.0.0.1:50000';
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe('relay');
    expect(registered.get('agent-1')).toBe('swlr_2');
  });
});

describe('the box valve and the memory guard', () => {
  it('passes the valve shedding on and off to the guard, once there is one', () => {
    const calls: boolean[] = [];
    let guard: { valveShedding: (on: boolean) => void } | null = null;
    const hook = valveSheddingHook(() => guard);
    // No guard yet: nothing to tell.
    hook(true);
    guard = { valveShedding: (on) => void calls.push(on) };
    hook(true);
    hook(false);
    expect(calls).toEqual([true, false]);
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
      guard: new LauncherGuard({ link, now: () => clock }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(() => clock),
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController({ ...deps(), log, split }, stop.signal);
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
      guard: new LauncherGuard({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
    };
    const base = deps();
    running = runController(
      { ...base, log, split, timing: { ...base.timing, launcherListenRetryMs: 50 } },
      stop.signal
    );
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
      guard: new LauncherGuard({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    const base = deps();
    running = runController(
      { ...base, log, split, timing: { ...base.timing, launcherListenRetryMs: 50 } },
      stop.signal
    );
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
      guard: new LauncherGuard({ link, now: Date.now }),
      runner: { launchOf: () => 1, currentLaunch: () => 1 },
      gate,
      operatorExec: true,
    };
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController({ ...deps(), log, split }, stop.signal);
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
  it('hands the gateway probe to the split runtime: a login check gets a swpg_ token, never the login', async () => {
    const socketPath = join(dir, 'launcher.sock');
    const link = new LauncherLink({ socketPath, now: Date.now, log: () => {} });
    let probeEnv: ProbeEnv | undefined;
    const split = {
      link,
      tickets: new HostTickets(),
      guard: new LauncherGuard({ link, now: Date.now }),
      runner: { launchOf: () => null, currentLaunch: () => null },
      gate: new LaunchGate(Date.now),
      setProbeEnv: (given: ProbeEnv | undefined) => {
        probeEnv = given;
      },
    };
    core.setAssignment({ revision: 1, agents: [] });
    running = runController({ ...deps(), providerGateway: true, split }, stop.signal);
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
