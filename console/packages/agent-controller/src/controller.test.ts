import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentBridgeEvent } from '@sandboxaq/switch-agent-runtime';
import { callOperation, SESSION_SELECTOR_HEADERS } from '@sandboxaq/switch-agent-runtime/hosted';
import { openHubStream, sealProviderLogin } from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ControllerDeps,
  type ControllerExit,
  ensureRelayCredentials,
  runController,
} from './controller';
import { ConfigurationError } from './errors';
import { adoptIdentity } from './handover';
import { silentLogger } from './log';
import type { LocalRelay } from './relay';
import type { AgentAssignment, StatusReport } from './schemas';
import { CONTROLLER_CREDENTIAL, FileSecretStore, MemorySecretStore } from './secrets';
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
    fetch,
    openWebSocket: core.openWebSocket,
    log: silentLogger,
    dataDir: dir,
    workspacesFor: () => join(dir, 'workspaces'),
    version: '0.1.0',
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
    worker: null,
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
      worker: null,
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

  it('exits as revoked when the credential exchange is refused as revoked', async () => {
    core.revoked = true;
    running = runController(deps(), stop.signal);
    expect(await running).toBe('revoked');
    expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

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
    store.markRevoked('2026-01-02T00:00:00Z');
    const wiped = runController(enrolled, stop.signal);
    await expect(wiped).rejects.toThrow(/revoked at/);
    await expect(wiped).rejects.toBeInstanceOf(ConfigurationError);
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
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe(true);
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe(false);
    expect(await ensureRelayCredentials('agent-1', login, deps)).toBe(true);
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
    expect(await ensureRelayCredentials('agent-1', { ...login, revision: '2' }, deps)).toBe(true);
    expect(await ensureRelayCredentials('agent-1', null, deps)).toBe(true);
    expect(runtime.credentials.get('agent-1')).toMatchObject({
      token: 'swlr_1',
      providerLogin: null,
    });
  });
});
