import { setTimeout as delay } from 'node:timers/promises';
import {
  type Eviction,
  SwitchEventStream,
  type WorkerFrameName,
  WorkerCallError,
} from '@sandboxaq/switch-agent-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessTokens, ControllerClient } from './api';
import { silentLogger } from './log';
import { LocalRelay, type WorkerLink } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentAssignment } from './schemas';
import { FakeCore } from './testing/fake-core';

/**
 * A cloud agent's watcher, run by the runtime's own protocol client exactly
 * as the hosted worker runs it, pointed at the relay: it opens as a worker,
 * is attached on the controller's connection, takes its protocol-7 frames
 * off its own stream and makes its up-calls through the relay.
 */

const AGENT = 'agent-1';
const WORKER_CONNECTION = 'worker-connection';
const CAPABILITY = 'worker-capability-placeholder-0123';
const quiet = { debug: () => {}, warn: () => {}, error: () => {} };
const CONNECTION = { connectionId: 'stream-connection-1', generation: 1 };

function assigned(agentId: string): AgentAssignment {
  return {
    agent_id: agentId,
    revision: 1,
    desired_state: 'running',
    definition: {
      name: agentId,
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      instructions: '',
      auto_session: true,
      auto_approve: false,
      directory: null,
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

let core: FakeCore;
let relay: LocalRelay;
let token: string;
let connection: { connectionId: string; generation: number } | null;
const stops: (() => void)[] = [];

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  core.setAssignment({ revision: 1, agents: [assigned(AGENT)] });
  const tokens = new AccessTokens({
    fetch,
    server: core.url,
    controllerId: core.controllerId,
    credential: async () => core.credential,
    now: Date.now,
    log: silentLogger,
  });
  const client = new ControllerClient({
    fetch,
    server: core.url,
    controllerId: core.controllerId,
    version: '0.1.0',
    tokens,
  });
  connection = CONNECTION;
  const workers: WorkerLink = {
    attach: async (agentId, worker) => {
      if (connection === null)
        return { ok: false, kind: 'unavailable', message: 'no stream to Switch' };
      return client.attachWorker(connection, agentId, worker);
    },
    detach: (agentId, worker) => {
      if (connection) void client.detachWorker(connection, agentId, worker).catch(() => {});
    },
  };
  relay = new LocalRelay({
    log: silentLogger,
    version: '0.1.0',
    forwarder: new UpstreamForwarder({
      server: core.url,
      auth: {
        token: () => tokens.get(),
        invalidate: (stale) => tokens.invalidate(stale),
        revoked: () => {},
      },
      log: silentLogger,
    }),
    workers,
    onCursor: () => {},
    onChange: () => {},
    now: Date.now,
    timing: { heartbeatTtlMs: 6_000, heartbeatIntervalS: 2, sweepMs: 50, keepaliveMs: 15_000 },
    bufferLimit: 100,
  });
  await relay.start(null);
  token = relay.mint(AGENT);
  relay.streamAttached();
  relay.attach(AGENT, 0, ['room-a']);
  relay.setReady();
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await relay.close();
  await core.stop();
});

/** The hosted worker's stream, as `HostedWorker` opens it. */
function worker() {
  const seen = {
    frames: [] as { name: WorkerFrameName; data: Record<string, unknown> }[],
    evictions: [] as Eviction[],
    connected: 0,
  };
  const controller = new AbortController();
  const stream = new SwitchEventStream({
    creds: { agentId: AGENT, apiEndpoint: relay.endpoint, token },
    connectionId: WORKER_CONNECTION,
    worker: {
      capability: CAPABILITY,
      bootId: 'boot-1',
      instanceId: 'i-0123456789abcdef0',
      stateVersion: 1,
    },
    onWorkerFrame: (name, data) => void seen.frames.push({ name, data }),
    scope: 'all',
    filter: 'addressed',
    spawnCapable: true,
    rooms: [],
    onEvent: () => {},
    onGap: () => {},
    onEvicted: (eviction) => void seen.evictions.push(eviction),
    onConnected: () => void seen.connected++,
    log: quiet,
    signal: controller.signal,
  });
  stream.start();
  const stop = () => controller.abort();
  stops.push(stop);
  return { stream, seen, stop };
}

function attaches() {
  return core.requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === `/v1/controllers/${core.controllerId}/agents/${AGENT}/worker`
  );
}

describe('a cloud agent worker on the relay', () => {
  it('is attached on the controller connection before its stream opens', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    expect(watcher.seen.frames[0]).toEqual({ name: 'worker_attached', data: core.workerAttached });
    const [attach] = attaches();
    const body = attach!.body as {
      connection_id: string;
      generation: number;
      worker: Record<string, unknown>;
    };
    expect(body.connection_id).toBe(CONNECTION.connectionId);
    expect(body.generation).toBe(CONNECTION.generation);
    expect(body.worker).toMatchObject({
      connection_id: WORKER_CONNECTION,
      spawn_capable: true,
      protocol: 7,
      protocol_accepts: 1,
      capability: CAPABILITY,
      boot_id: 'boot-1',
      instance_id: 'i-0123456789abcdef0',
      state_version: 1,
    });
    expect(attach!.headers.authorization).toMatch(/^Bearer access-token-/);
    expect(core.workers.get(AGENT)?.connectionId).toBe(WORKER_CONNECTION);
  });

  it('gets its protocol-7 frames off the controller stream, unchanged', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    const attached = core.workers.get(AGENT)!;
    relay.workerFrame({
      agent_id: AGENT,
      connection_id: attached.connectionId,
      generation: attached.generation,
      event: 'operation',
      data: { id: 'operation-1' },
    });
    relay.workerFrame({
      agent_id: AGENT,
      connection_id: attached.connectionId,
      generation: attached.generation,
      event: 'relay',
      data: { id: 'relay-1', deadline_ms: 0, relay_seq: null, message: { list: {} } },
    });
    await waitFor(() => watcher.seen.frames.length === 3, 'the relayed frames');
    expect(watcher.seen.frames.slice(1)).toEqual([
      { name: 'operation', data: { id: 'operation-1' } },
      {
        name: 'relay',
        data: { id: 'relay-1', deadline_ms: 0, relay_seq: null, message: { list: {} } },
      },
    ]);
  });

  it('drops a frame for another incarnation of the worker', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    const attached = core.workers.get(AGENT)!;
    relay.workerFrame({
      agent_id: AGENT,
      connection_id: attached.connectionId,
      generation: attached.generation + 1,
      event: 'operation',
      data: { id: 'stale' },
    });
    await delay(100);
    expect(watcher.seen.frames.map((frame) => frame.name)).toEqual(['worker_attached']);
  });

  it('makes its up-calls through the relay as the controller, acting as the agent', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    const attached = core.workers.get(AGENT)!;
    await watcher.stream.workerCall(`/agents/${AGENT}/connection/idle`, { busy: false });
    await watcher.stream.workerCall('/hosted/operations/operation-1/claim', {});
    const idle = core.requests.find(
      (request) => request.path === `/agents/${AGENT}/connection/idle`
    );
    expect(idle?.headers['x-switch-agent-id']).toBe(AGENT);
    expect(idle?.headers.authorization).toMatch(/^Bearer access-token-/);
    expect(idle?.body).toEqual({
      busy: false,
      connection_id: WORKER_CONNECTION,
      generation: attached.generation,
    });
    const claim = core.requests.find(
      (request) => request.path === '/hosted/operations/operation-1/claim'
    );
    expect(claim?.headers['x-switch-agent-id']).toBe(AGENT);
  });

  it('forwards the cloud agent routes and nothing of the machine', async () => {
    const credential = await fetch(`${relay.endpoint}/hosted/provider-credential`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(credential.status).toBe(200);
    const forwarded = core.requests.find(
      (request) => request.path === '/hosted/provider-credential'
    );
    expect(forwarded?.headers['x-switch-agent-id']).toBe(AGENT);
    const machine = await fetch(`${relay.endpoint}/hosted/machines/machine-1/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(machine.status).toBe(404);
    expect(core.requests.some((request) => request.path.startsWith('/hosted/machines'))).toBe(
      false
    );
  });

  it('is told Switch refused it with Switch’s own code, and stops', async () => {
    core.workerRefusal = {
      status: 403,
      body: {
        detail: {
          code: 'worker_capability_obsolete',
          message: 'This worker capability is not the one for the launch.',
        },
      },
    };
    const watcher = worker();
    await waitFor(() => watcher.seen.evictions.length > 0, 'the refusal');
    expect(watcher.seen.evictions[0]?.code).toBe('worker_capability_obsolete');
    expect(watcher.seen.frames).toEqual([]);
  });

  it('retries while the controller has no stream to Switch, then attaches', async () => {
    connection = null;
    relay.setUpstream(false);
    const watcher = worker();
    await delay(300);
    expect(watcher.seen.frames).toEqual([]);
    expect(watcher.seen.evictions).toEqual([]);
    connection = CONNECTION;
    relay.streamAttached();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached', 15_000);
    expect(watcher.seen.frames[0]?.name).toBe('worker_attached');
  }, 20_000);

  it('is evicted with Switch’s code when its attachment ends', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    const attached = core.workers.get(AGENT)!;
    relay.workerClosed({
      agent_id: AGENT,
      connection_id: attached.connectionId,
      generation: attached.generation,
      code: 'launch_superseded',
      reason: 'the hosted launch moved to a newer revision',
    });
    await waitFor(() => watcher.seen.evictions.length > 0, 'the eviction');
    expect(watcher.seen.evictions[0]?.code).toBe('launch_superseded');
  });

  it('is let go of in Switch when its stream ends', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    watcher.stop();
    await waitFor(() => !core.workers.has(AGENT), 'the detach');
  });

  it('attaches again when the controller reconnects to Switch', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    relay.setUpstream(false);
    relay.streamAttached();
    await waitFor(() => attaches().length >= 2, 'a second attach', 15_000);
    await waitFor(
      () => watcher.seen.frames.filter((frame) => frame.name === 'worker_attached').length >= 2,
      'a second worker_attached',
      15_000
    );
  }, 20_000);

  it('turns a worker call refused by Switch into the runtime’s error', async () => {
    const watcher = worker();
    await waitFor(() => watcher.seen.frames.length > 0, 'worker_attached');
    core.scripted.push({
      method: 'POST',
      path: `/agents/${AGENT}/connection/idle`,
      status: 409,
      body: { detail: { code: 'generation_changed', message: 'reattach' } },
    });
    await expect(
      watcher.stream.workerCall(`/agents/${AGENT}/connection/idle`, {})
    ).rejects.toBeInstanceOf(WorkerCallError);
  });
});
