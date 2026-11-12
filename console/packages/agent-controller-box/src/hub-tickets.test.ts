import { setTimeout as delay } from 'node:timers/promises';
import type { SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime-box';
import { HUB_CLOSE, HUB_PROTOCOL, openHubStream } from '@switch-console/agent-providers-box';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentHub } from './agent-hub';
import { AccessTokens } from './api';
import { HostTickets } from './host-tickets';
import { HubSocket } from './hub-socket';
import { silentLogger } from './log';
import { LocalRelay } from './relay';
import { UpstreamForwarder } from './relay-forward';
import { FakeCore } from './testing/fake-core';

/**
 * On a split box (the controller as its own user): a host's hub hello must carry the
 * one-time ticket minted for its launch, or it is refused and logged (C9).
 */

let core: FakeCore;
let relay: LocalRelay;
let tickets: HostTickets;
let warned: [string, unknown][];
let reconnecting: string[];
let refusedWith: [string, string][];
let current: number | null;

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  const hub = new AgentHub({
    log: silentLogger,
    bufferLimit: 100,
    onCursor: () => {},
    onChange: () => {},
  });
  tickets = new HostTickets();
  warned = [];
  reconnecting = [];
  refusedWith = [];
  current = 1;
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
    hub: new HubSocket({
      hub,
      log: {
        ...silentLogger,
        warn: (message: string, fields?: unknown) => void warned.push([message, fields]),
      },
      tickets,
      onTicketedClosed: (agentId) => void reconnecting.push(agentId),
      currentLaunch: () => current,
      onTicketRefused: (agentId, reason) => void refusedWith.push([agentId, reason]),
    }),
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
  relay.setReady();
});
afterEach(async () => {
  await relay.close();
  await core.stop();
});

/** A host saying hello, with or without a ticket: resolves to its close code, or 'open' if kept. */
function hello(agentId: string, ticket?: string): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(relay.hubUrl, {
      headers: { Authorization: `Bearer ${relay.mint(agentId)}` },
    });
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
    }, 400);
  });
}

describe('the hub on split boxes', () => {
  it('lets in a host with its launch ticket, once', async () => {
    const ticket = tickets.mint('agent-1', 1);
    expect(await hello('agent-1', ticket)).toBe('open');
    expect(await hello('agent-1', ticket)).toBe(HUB_CLOSE.refused);
    expect(warned).toEqual([
      [
        'Refused an agent host’s hub hello: its launch ticket was not good',
        { agentId: 'agent-1', reason: 'spent' },
      ],
    ]);
  });

  it('asks for a fresh ticket when a ticketed host drops, never for a refused one', async () => {
    expect(await hello('agent-1')).toBe(HUB_CLOSE.refused);
    expect(reconnecting).toEqual([]);
    expect(await hello('agent-1', tickets.mint('agent-1', 1))).toBe('open');
    await delay(50);
    expect(reconnecting).toEqual(['agent-1']);
  });

  it('refuses a good ticket for a launch that is no longer the agent’s current one, and says why', async () => {
    const old = tickets.mint('agent-1', 1);
    current = 2;
    expect(await hello('agent-1', old)).toBe(HUB_CLOSE.refused);
    expect(refusedWith).toEqual([['agent-1', 'stale_launch']]);
  });

  it('tells the controller each refusal reason, so only spent and wrong-agent tickets count towards failure', async () => {
    const ticket = tickets.mint('agent-1', 1);
    expect(await hello('agent-1', ticket)).toBe('open');
    expect(await hello('agent-1', ticket)).toBe(HUB_CLOSE.refused);
    expect(await hello('agent-1')).toBe(HUB_CLOSE.refused);
    expect(refusedWith.map(([, reason]) => reason)).toEqual(['spent', 'missing']);
  });

  it('refuses a host the controller did not launch (no ticket), and a guessed one', async () => {
    expect(await hello('agent-1')).toBe(HUB_CLOSE.refused);
    expect(await hello('agent-1', 'f'.repeat(32))).toBe(HUB_CLOSE.refused);
    expect(warned.map(([, fields]) => (fields as { reason: string }).reason)).toEqual([
      'missing',
      'unknown',
    ]);
  });
});

describe('an agent host on a split box', () => {
  /** Opens the host's hub stream as the shared daemon does, taking each hello's ticket from `next`. */
  function host(next: () => Promise<string | undefined>) {
    const hostWarnings: string[] = [];
    const controller = new AbortController();
    const stream = openHubStream(relay.hubUrl, { ticket: next })({
      creds: { agentId: 'agent-1', apiEndpoint: relay.endpoint, token: relay.mint('agent-1') },
      connectionId: 'agent-1-connection',
      scope: 'all',
      filter: 'addressed',
      rooms: [],
      onEvent: () => {},
      onGap: () => {},
      onEvicted: () => {},
      log: {
        debug: () => {},
        info: () => {},
        warn: (m: string) => void hostWarnings.push(m),
        error: () => {},
      },
      signal: controller.signal,
    } as SwitchEventStreamDeps);
    stream.start();
    return { hostWarnings, stop: () => controller.abort() };
  }

  it('waits for the ticket the launcher hands it, then spends it at hello', async () => {
    let give!: (ticket: string) => void;
    const handed = new Promise<string>((resolve) => (give = resolve));
    const h = host(() => handed);
    await delay(200);
    const ticket = tickets.mint('agent-1', 1);
    give(ticket);
    await delay(400);
    h.stop();
    // The hub took it: it is spent, and nothing was refused.
    expect(tickets.take('agent-1', ticket)).toEqual({ ok: false, reason: 'spent' });
    expect(warned).toEqual([]);
  });

  it('never says hello without a ticket: it waits, and says so', async () => {
    const h = host(async () => undefined);
    await delay(300);
    h.stop();
    expect(warned).toEqual([]);
    expect(h.hostWarnings[0]).toBe(
      'No launch ticket from the launcher yet; the agent host waits for one.'
    );
  });
});
