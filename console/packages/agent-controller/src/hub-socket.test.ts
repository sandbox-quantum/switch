import { setTimeout as delay } from 'node:timers/promises';
import { HUB_CLOSE, HUB_PROTOCOL } from '@switch-console/agent-providers';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentHub } from './agent-hub';
import { AccessTokens } from './api';
import { HubSocket, type HubValve, type HubValveLink } from './hub-socket';
import { silentLogger } from './log';
import { LocalRelay } from './relay';
import { UpstreamForwarder } from './relay-forward';
import { FakeCore } from './testing/fake-core';

/**
 * The hub socket with box mode off (desktop and self-installed machines: as before) and on (the
 * frame cap, and the valve's frames kept off the hub's own messages). The
 * real box valve is tested in `box/hub-valve.test.ts`; here a stand-in is enough.
 */

let core: FakeCore;
let relay: LocalRelay;

async function start(options: { box?: boolean; valve?: HubValve } = {}): Promise<void> {
  core = new FakeCore();
  await core.start();
  const hub = new AgentHub({
    log: silentLogger,
    bufferLimit: 100,
    onCursor: () => {},
    onChange: () => {},
  });
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
    hub: new HubSocket({ hub, log: silentLogger, ...options }),
    forwarder: new UpstreamForwarder({
      server: core.url,
      auth: { token: () => tokens.get(), invalidate: () => {}, revoked: () => {} },
      log: silentLogger,
    }),
  });
  await relay.start(null);
  hub.streamAttached();
  hub.attach('agent-1', 0, ['room-a']);
  relay.setReady();
}

async function connect(): Promise<WebSocket> {
  const socket = new WebSocket(relay.hubUrl, {
    headers: { Authorization: `Bearer ${relay.mint('agent-1')}` },
  });
  await new Promise((resolve) => socket.once('open', resolve));
  return socket;
}

const closeCode = (socket: WebSocket) =>
  new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

const hello = JSON.stringify({
  type: 'hello',
  protocol: HUB_PROTOCOL,
  startCursor: null,
  placements: {},
});
const bigValveFrame = JSON.stringify({
  type: 'valve',
  op: 'state',
  pad: 'x'.repeat(2 * 1024 * 1024),
});

/** A stand-in for the box valve: says which frames are its own and records who joined. */
function standInValve(proven: boolean) {
  const joined: string[] = [];
  const received: string[] = [];
  const valve: HubValve = {
    valve: { enabled: true },
    ready: Promise.resolve(),
    trusted: async () => proven,
    share: () => 1,
    isFrame: (raw) => raw.startsWith('{"type":"valve"'),
    join: ({ agentId }): HubValveLink => {
      joined.push(agentId);
      return { receive: (raw) => void received.push(raw), close: () => {} };
    },
  };
  return { valve, joined, received };
}

afterEach(async () => {
  await relay.close();
  await core.stop();
});

describe('the hub socket with box mode off', () => {
  it('sets no frame cap: a 2 MiB frame is read, and refused as unreadable rather than too big', async () => {
    await start();
    const socket = await connect();
    const closed = closeCode(socket);
    socket.send(bigValveFrame);
    expect(await closed).toBe(HUB_CLOSE.refused);
  });

  it('reads a valve-shaped frame as a hub message, and closes the connection over it', async () => {
    await start({ box: false });
    const socket = await connect();
    const closed = closeCode(socket);
    socket.send(hello);
    socket.send(JSON.stringify({ type: 'valve', op: 'admit', requestId: 1 }));
    expect(await closed).toBe(HUB_CLOSE.refused);
  });
});

describe('the hub socket with box mode on', () => {
  it('closes a connection that sends a frame over 1 MiB, before buffering it all', async () => {
    await start({ box: true });
    const socket = await connect();
    const closed = closeCode(socket);
    socket.send(bigValveFrame);
    expect(await closed).toBe(1009);
  });

  it('a proven host joins the valve, and its valve frames go to the valve', async () => {
    const stand = standInValve(true);
    await start({ box: true, valve: stand.valve });
    const socket = await connect();
    socket.send(hello);
    for (let tries = 0; !stand.joined.length && tries < 100; tries++) await delay(10);
    expect(stand.joined).toEqual(['agent-1']);
    const frame = JSON.stringify({ type: 'valve', op: 'admit', requestId: 1 });
    socket.send(frame);
    for (let tries = 0; !stand.received.length && tries < 100; tries++) await delay(10);
    expect(stand.received).toEqual([frame]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('drops the valve frames of an unproven host, and keeps its hub connection', async () => {
    const stand = standInValve(false);
    await start({ box: true, valve: stand.valve });
    const socket = await connect();
    socket.send(hello);
    socket.send(JSON.stringify({ type: 'valve', op: 'admit', requestId: 1 }));
    await delay(100);
    expect(stand.joined).toEqual([]);
    expect(stand.received).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
