import { setTimeout as delay } from 'node:timers/promises';
import type { SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime-box';
import { BoxValve, HubHostValve, openHubStream } from '@switch-console/agent-providers-box';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentHub } from './agent-hub';
import { AccessTokens } from './api';
import { HubSocket, type HubValve } from './hub-socket';
import { silentLogger } from './log';
import { LocalRelay } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentAssignment } from './schemas';
import { FakeCore } from './testing/fake-core';

/**
 * The box valve on the hub: an isolated host joins the controller's
 * one valve over its hub connection, only once the guard's holds are
 * restored and only if the connection is proved to be the agent's own host.
 */

const GIB = 1024 ** 3;
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

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
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
      directory: null,
      isolation: 'isolated',
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

let core: FakeCore;
let hub: AgentHub;
let relay: LocalRelay;
let valve: BoxValve;
let trust: { proven: boolean; asked: { agentId: string; peer: number; local: number }[] };
let openGate: () => void;
let hubSocket: HubSocket;
const stops: (() => void)[] = [];

function start(options: { gateOpen?: boolean } = {}) {
  return (async () => {
    core = new FakeCore();
    await core.start();
    core.setAssignment({ revision: 1, agents: [assigned('agent-1'), assigned('agent-2')] });
    hub = new AgentHub({
      log: silentLogger,
      bufferLimit: 100,
      onCursor: () => {},
      onChange: () => {},
    });
    valve = new BoxValve({
      limit: 6 * GIB,
      readUsage: async () => 0,
      cap: 1,
      settleMs: 0,
      log: { info: () => {}, warn: () => {} },
    });
    trust = { proven: true, asked: [] };
    const ready = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    if (options.gateOpen !== false) openGate();
    const hubValve: HubValve = {
      valve,
      ready,
      trusted: async (agentId, peer, local) => {
        trust.asked.push({ agentId, peer, local });
        return trust.proven;
      },
      share: () => 1,
    };
    const tokens = new AccessTokens({
      fetch,
      server: core.url,
      controllerId: core.controllerId,
      credential: async () => core.credential,
      now: Date.now,
      log: silentLogger,
    });
    relay = new LocalRelay({
      log: silentLogger,
      roomFor: (agentId, sessionId) => hub.roomFor(agentId, sessionId),
      hub: (hubSocket = new HubSocket({ hub, log: silentLogger, valve: hubValve })),
      forwarder: new UpstreamForwarder({
        server: core.url,
        auth: { token: () => tokens.get(), invalidate: () => {}, revoked: () => {} },
        log: silentLogger,
        sessionStarted: () => {},
      }),
    });
    await relay.start(null);
    hub.streamAttached();
    hub.attach('agent-1', 0, ['room-a']);
    hub.attach('agent-2', 0, ['room-b']);
    relay.setReady();
  })();
}

/** An isolated agent host, as the shared daemon opens it: its hub stream and the valve riding on it. */
function isolatedHost(agentId: string, awake = 0) {
  const open = openHubStream(relay.hubUrl);
  const controller = new AbortController();
  const stream = open({
    creds: { agentId, apiEndpoint: relay.endpoint, token: relay.mint(agentId) },
    connectionId: `${agentId}-connection`,
    scope: 'all',
    filter: 'addressed',
    rooms: [],
    onEvent: () => {},
    onGap: () => {},
    onEvicted: () => {},
    log: quiet,
    signal: controller.signal,
  } as SwitchEventStreamDeps);
  const client = new HubHostValve(
    open.valveChannel!,
    { limit: 6 * GIB, readUsage: async () => 0, startReserve: 0 },
    { log: { info: () => {}, warn: () => {} } }
  );
  client.attach(
    { awake: () => awake, idle: () => [], waiting: () => [] },
    { start: async () => {}, letGo: () => {} }
  );
  stream.start();
  const stop = () => controller.abort();
  stops.push(stop);
  return { client, stop };
}

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await relay.close();
  await core.stop();
});

describe('the box valve over the hub', () => {
  beforeEach(() => start());

  it('a proven host joins the box valve, and the cap holds across agents', async () => {
    const one = isolatedHost('agent-1');
    const two = isolatedHost('agent-2');
    await waitFor(() => one.client.boxWide && two.client.boxWide, 'both hosts on the valve');
    const first = await one.client.admit('s1', 'message');
    expect(first.ok).toBe(true);
    // The box's one slot is taken by agent-1's start: agent-2 is refused box-wide.
    expect(await two.client.admit('s2', 'message')).toEqual({ ok: false, reason: 'cap' });
    expect(valve.starting).toBe(1);
  });

  it('asks the trust check with the connection’s own ports', async () => {
    const one = isolatedHost('agent-1');
    await waitFor(() => one.client.boxWide, 'the host on the valve');
    expect(trust.asked).toHaveLength(1);
    expect(trust.asked[0]!.agentId).toBe('agent-1');
    expect(trust.asked[0]!.local).toBe(Number(new URL(relay.hubUrl).port));
    expect(trust.asked[0]!.peer).toBeGreaterThan(0);
  });

  it('a host’s leases go the moment its hub connection closes', async () => {
    const one = isolatedHost('agent-1');
    await waitFor(() => one.client.boxWide, 'the host on the valve');
    expect((await one.client.admit('s1', 'message')).ok).toBe(true);
    one.stop();
    await waitFor(() => valve.starting === 0, 'the lease to go');
  });

  it('a controller restart: the hub closes, the host reconnects, is proved again and rejoins', async () => {
    const one = isolatedHost('agent-1');
    await waitFor(() => one.client.boxWide, 'the host on the valve');
    expect((await one.client.admit('s1', 'message')).ok).toBe(true);
    // As a controller stopping: every hub connection closed as a restart.
    await hubSocket.close();
    await waitFor(() => !one.client.boxWide, 'the host off the valve');
    // Its lease went with the connection; its fallback holds meanwhile.
    expect(valve.starting).toBe(0);
    await waitFor(() => one.client.boxWide, 'the host back on the valve');
    // Proved again on the new connection, not trusted from the old one.
    expect(trust.asked).toHaveLength(2);
    expect(trust.asked[1]!.peer).not.toBe(trust.asked[0]!.peer);
  });

  it('another agent’s token can’t join as this agent: the proof is asked for the token’s agent', async () => {
    const two = isolatedHost('agent-2');
    await waitFor(() => trust.asked.length === 1, 'the trust check');
    expect(trust.asked[0]!.agentId).toBe('agent-2');
    void two;
  });

  it('counts the hosts on the hub and those that joined the valve, for the status', async () => {
    const one = isolatedHost('agent-1');
    await waitFor(() => one.client.boxWide, 'the first host on the valve');
    trust.proven = false;
    isolatedHost('agent-2');
    await waitFor(() => trust.asked.length === 2, 'the second trust check');
    await waitFor(() => hubSocket.valveHosts().hosts === 2, 'both hosts on the hub');
    expect(hubSocket.valveHosts()).toEqual({ joined: 1, hosts: 2 });
  });

  it('closes a connection that sends a frame over 1 MiB, before buffering it all', async () => {
    const socket = new WebSocket(relay.hubUrl, {
      headers: { Authorization: `Bearer ${relay.mint('agent-1')}` },
    });
    await new Promise((resolve) => socket.once('open', resolve));
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify({ type: 'valve', op: 'state', pad: 'x'.repeat(2 * 1024 * 1024) }));
    expect(await closed).toBe(1009);
  });

  it('an unproven connection stays off the valve: no ready, its valve messages dropped, the hub kept', async () => {
    trust.proven = false;
    const one = isolatedHost('agent-1');
    await waitFor(() => trust.asked.length === 1, 'the trust check');
    await delay(50);
    expect(one.client.boxWide).toBe(false);
    // A raw client with the relay token, sending valve messages anyway.
    const socket = new WebSocket(relay.hubUrl, {
      headers: { Authorization: `Bearer ${relay.mint('agent-2')}` },
    });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, startCursor: null, placements: {} }));
    await waitFor(() => trust.asked.length === 2, 'the second trust check');
    socket.send(
      JSON.stringify({ type: 'valve', op: 'admit', requestId: 1, sessionId: 's', kind: 'message' })
    );
    await delay(50);
    expect(valve.starting).toBe(0);
    // The hub connection stays up: valve messages are dropped, not a reason to close it.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

describe('the box valve over the hub, before the guard’s holds are restored', () => {
  beforeEach(() => start({ gateOpen: false }));

  it('no host joins until the gate opens', async () => {
    const one = isolatedHost('agent-1');
    await delay(200);
    expect(trust.asked).toHaveLength(0);
    expect(one.client.boxWide).toBe(false);
    openGate();
    await waitFor(() => one.client.boxWide, 'the host on the valve');
  });
});
