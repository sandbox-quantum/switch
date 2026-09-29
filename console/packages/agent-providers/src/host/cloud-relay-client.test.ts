import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerEvent, Session, Snapshot } from '@switch-console/shared/session-v1';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAX_CHUNK_BYTES } from './attachment-transfers';
import { CloudRelayClient, CloudRelayError } from './cloud-relay-client';
import { SessionHostFailedError, SessionUnavailableError } from './session-channel';

type Reply = { status: number; body: unknown };
type Relayed = { message: Record<string, unknown>; timeout_ms: number };

const worker = { launch_revision: 3, boot_id: 'boot', generation: 1 };
const ok = (value: unknown): Reply => ({ status: 200, body: { ok: true, value, worker } });
const refused = (status: number, code: string, message = code, extra = {}): Reply => ({
  status,
  body: { ok: false, error: { code, message }, worker, ...extra },
});

let server: Server;
let base: string;
let relayed: Relayed[];
let answer: (message: Record<string, unknown>) => Reply;
let streams: { query: URLSearchParams; response: ServerResponse }[];

beforeEach(async () => {
  relayed = [];
  streams = [];
  answer = () => refused(500, 'unexpected');
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    if (request.method === 'GET' && url.pathname === '/launch/relay/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': keepalive\n\n');
      streams.push({ query: url.searchParams, response });
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      if (url.pathname !== '/launch/relay') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Cloud launch not found.' }));
        return;
      }
      const parsed = JSON.parse(body) as Relayed;
      relayed.push(parsed);
      const reply = answer(parsed.message);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const { response } of streams) response.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function client(launch = 'launch', retryMs = 2000): CloudRelayClient {
  return new CloudRelayClient(
    (path, init) =>
      fetch(`${base}/${launch}${path}`, {
        method: init.method,
        headers: { 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      }),
    { retryMs, timeoutMs: 1000 }
  );
}

function frame(index: number, event: string, data: unknown): void {
  streams[index]!.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const session = (sessionId: string): Session => ({
  sessionId,
  agentId: 'agent',
  hostId: 'host',
  epoch: 'epoch-1',
  provider: 'claude',
  status: 'ready',
  connectivity: 'online',
  pendingRequestIds: [],
  capabilities: {
    input: 'queue',
    approvals: true,
    questions: true,
    interrupt: true,
    reset: true,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: ['text/plain'],
  },
});

const snapshot = (text: string): Snapshot => ({
  contractVersion: 1,
  throughSequence: 7,
  session: session('one'),
  turns: [{ type: 'turn.upsert', turnId: 'turn', status: 'completed', commandId: 'command' }],
  items: [
    {
      itemId: 'item',
      turnId: 'turn',
      revision: 1,
      kind: 'assistant-message',
      status: 'completed',
      title: '',
      text,
      attachments: [],
      origin: null,
    },
  ],
  requests: [],
  commandStatuses: [],
  notices: [],
  nextPageToken: null,
});

const event = (sequence: number): ServerEvent => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 'one',
  sequence,
  occurredAt: '2026-09-25T12:00:00.000Z',
  body: { type: 'turn.upsert', turnId: 'turn', status: 'running', commandId: 'command' },
});

/** Answers paged the way the worker pages them, `size` bytes a page. */
function pager(value: unknown, size: number) {
  const data = Buffer.from(JSON.stringify(value));
  const pages: Buffer[] = [];
  for (let at = 0; at < data.byteLength; at += size) pages.push(data.subarray(at, at + size));
  let pins = 0;
  const first = () => {
    pins++;
    return ok({
      snapshotId: `snap-${pins}`,
      epoch: 'epoch-1',
      throughSequence: 7,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      pageCount: pages.length,
      page: { index: 0, data: pages[0]!.toString('base64') },
    });
  };
  const page = (message: Record<string, unknown>) => {
    const { snapshotId, index } = message.page as { snapshotId: string; index: number };
    return ok({ snapshotId, page: { index, data: pages[index]!.toString('base64') } });
  };
  return { first, page, count: pages.length, pins: () => pins };
}

it('reassembles a paged snapshot and checks it against its digest', async () => {
  const value = snapshot('x'.repeat(5000));
  const pages = pager(value, 1500);
  answer = (message) => ('page' in message ? pages.page(message) : pages.first());
  const result = await client().request('one', { type: 'snapshot' });
  expect(result).toEqual(value);
  expect(pages.count).toBeGreaterThan(3);
  expect(relayed.map((each) => each.message)).toEqual([
    { sessionId: 'one', request: { type: 'snapshot' } },
    ...Array.from({ length: pages.count - 1 }, (_, index) => ({
      page: { snapshotId: 'snap-1', index: index + 1 },
    })),
  ]);
  expect(relayed.every((each) => each.timeout_ms === 1000)).toBe(true);
});

it('asks for a paged answer again when its pin expires, and gives up after three', async () => {
  const pages = pager([session('one'), session('two')], 200);
  let expire = 1;
  answer = (message) => {
    if (!('page' in message)) return pages.first();
    if (expire-- > 0) return refused(409, 'snapshot_expired', 'The snapshot expired.');
    return pages.page(message);
  };
  expect((await client().list()).map((each) => each.sessionId)).toEqual(['one', 'two']);
  expect(pages.pins()).toBe(2);

  answer = (message) => ('page' in message ? refused(409, 'snapshot_superseded') : pages.first());
  await expect(client().list()).rejects.toMatchObject({ relayCode: 'snapshot_superseded' });
  expect(pages.pins()).toBe(5);
});

it('refuses a paged answer that does not match its digest', async () => {
  const pages = pager(snapshot('text'), 100);
  answer = (message) => {
    if ('page' in message) return pages.page(message);
    const first = pages.first();
    (first.body as { value: { sha256: string } }).value.sha256 = '0'.repeat(64);
    return first;
  };
  await expect(client().journal('one')).rejects.toThrow(/does not match its digest/);
});

it('reports a sleeping launch with whether it can be woken, without asking again', async () => {
  answer = () =>
    refused(409, 'worker_sleeping', 'The cloud worker is asleep.', { wake_available: true });
  const error = await client()
    .health()
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CloudRelayError);
  expect(error).toMatchObject({ relayCode: 'worker_sleeping', status: 409, wakeAvailable: true });
  expect(relayed).toHaveLength(1);
});

it('asks again while the worker is waking or busy, within its window', async () => {
  const replies = [refused(409, 'worker_waking'), refused(503, 'worker_busy')];
  answer = () =>
    replies.shift() ??
    ok({ state: 'connected', detail: null, since: '2026-09-25T12:00:00Z', placements: {} });
  expect((await client().health()).state).toBe('connected');
  expect(relayed).toHaveLength(3);

  answer = () => refused(409, 'worker_not_attached', 'No worker is attached.');
  await expect(client('launch', 300).health()).rejects.toMatchObject({
    relayCode: 'worker_not_attached',
  });
});

it('never sends a command twice on a timeout or a changed worker', async () => {
  const command = {
    type: 'command' as const,
    command: {
      contractVersion: 1 as const,
      commandId: 'command',
      sessionId: 'one',
      origin: null,
      body: { type: 'interrupt' as const },
    },
  };
  answer = () => refused(504, 'relay_timeout', 'The worker did not answer in time.');
  await expect(client().request('one', command as never)).rejects.toMatchObject({
    relayCode: 'relay_timeout',
    status: 504,
  });
  expect(relayed).toHaveLength(1);

  answer = () => refused(409, 'generation_changed');
  await expect(client().place('one', '!room:example')).rejects.toMatchObject({
    relayCode: 'generation_changed',
  });
  expect(relayed).toHaveLength(2);

  const replies = [refused(409, 'generation_changed')];
  answer = () => replies.shift() ?? ok({ status: 'accepted' });
  await client().request('one', { type: 'commandStatus', commandId: 'command' } as never);
  expect(relayed).toHaveLength(4);
});

it('raises the errors a sidecar raises for a stopped or failed session', async () => {
  answer = () => refused(409, 'session_unavailable', 'Session one is not running.');
  await expect(client().forget('one')).rejects.toBeInstanceOf(SessionUnavailableError);

  answer = () => refused(409, 'session_failed', 'The session host failed: out of credits');
  const failed = await client()
    .forget('one')
    .catch((caught: unknown) => caught);
  expect(failed).toBeInstanceOf(SessionHostFailedError);
  expect((failed as SessionHostFailedError).failure).toBe('out of credits');

  answer = () => refused(400, 'refused_message', 'Console may not send that.');
  await expect(client().forget('one')).rejects.toMatchObject({ relayCode: 'refused_message' });

  await expect(client('elsewhere').forget('one')).rejects.toMatchObject({
    relayCode: 'not_found',
    status: 404,
  });
});

it('uploads an attachment in chunks, resending one whose reply was lost', async () => {
  const data = Buffer.alloc(MAX_CHUNK_BYTES * 2 + 1234);
  for (let at = 0; at < data.byteLength; at++) data[at] = at % 251;
  const received: Buffer[] = [];
  let lose = 1;
  answer = (message) => {
    const chunk = message.attachment as { index: number; count: number; chunk: string };
    if (chunk.index === 1 && lose-- > 0) return refused(504, 'relay_timeout');
    received[chunk.index] = Buffer.from(chunk.chunk, 'base64');
    return chunk.index === chunk.count - 1
      ? ok({ staged: { transferId: 'id', ref: 'ref-1' } })
      : ok({ next: chunk.index + 1 });
  };
  const attachment = await client().uploadAttachment('one', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    data,
  });
  expect(attachment).toEqual({
    attachmentId: 'ref-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
  expect(Buffer.concat(received).equals(data)).toBe(true);
  const chunks = relayed.map(
    (each) => each.message.attachment as { transferId: string; index: number; count: number }
  );
  expect(chunks.map((each) => each.index)).toEqual([0, 1, 1, 2]);
  expect(new Set(chunks.map((each) => each.transferId)).size).toBe(1);
  expect(chunks.every((each) => each.count === 3)).toBe(true);
});

it('cancels a transfer the worker refused', async () => {
  answer = (message) =>
    'attachmentCancel' in message
      ? ok(null)
      : refused(400, 'staging_full', 'Too many attachments are staged.');
  await expect(
    client().uploadAttachment('one', {
      name: 'a.txt',
      mimeType: 'text/plain',
      data: Buffer.from('hello'),
    })
  ).rejects.toMatchObject({ relayCode: 'staging_full' });
  const transferId = (relayed[0]!.message.attachment as { transferId: string }).transferId;
  expect(relayed[1]!.message).toEqual({ attachmentCancel: transferId });

  await expect(
    client().uploadAttachment('one', {
      name: 'big.bin',
      mimeType: 'text/plain',
      data: Buffer.alloc(10 * 1024 * 1024 + 1),
    })
  ).rejects.toThrow(/larger than 10 MiB/);
});

it('delivers a session’s events once Switch holds the view, and resets it on a resync', async () => {
  const relay = client();
  const events: number[] = [];
  const failures: (string | null)[] = [];
  const onReset = vi.fn();
  const subscribing = relay.subscribe(
    'one',
    (each) => events.push(each.sequence),
    (failure) => failures.push(failure),
    onReset
  );
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  expect(streams[0]!.query.get('subscribe')).toBe('one');
  frame(0, 'worker', worker);
  const off = await subscribing;
  frame(0, 'event', { sessionId: 'one', event: event(8) });
  frame(0, 'failure', { sessionId: 'one', failure: 'out of credits' });
  frame(0, 'event', { sessionId: 'one', event: event(9) });
  await vi.waitFor(() => expect(events).toEqual([8, 9]));
  expect(failures).toEqual(['out of credits']);
  frame(0, 'resync', { sessionId: 'one', reason: 'overflow' });
  frame(0, 'event', { sessionId: 'one', event: event(10) });
  await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
  expect(onReset.mock.calls[0]![0]).toMatch(/overflow/);
  expect(events).toEqual([8, 9]);
  off();
});

it('resets a view when the worker behind it changes or the stream ends', async () => {
  const relay = client();
  const onReset = vi.fn();
  const subscribing = relay.subscribe(
    'one',
    () => {},
    () => {},
    onReset
  );
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  frame(0, 'worker', worker);
  frame(0, 'worker', worker);
  await subscribing;
  frame(0, 'worker', { ...worker, generation: 2 });
  await vi.waitFor(() => expect(onReset).toHaveBeenCalledWith('The cloud worker changed.'));

  const again = vi.fn();
  const second = relay.subscribe(
    'one',
    () => {},
    () => {},
    again
  );
  await vi.waitFor(() => expect(streams).toHaveLength(2));
  frame(1, 'worker', worker);
  await second;
  streams[1]!.response.end();
  await vi.waitFor(() => expect(again).toHaveBeenCalledOnce());
});

it('refuses a view of a launch Switch will not relay', async () => {
  await expect(
    client('elsewhere').subscribe(
      'one',
      () => {},
      () => {},
      () => {}
    )
  ).rejects.toMatchObject({ relayCode: 'not_found' });
});

it('follows the watcher’s health and closes when its stream ends', async () => {
  const relay = client();
  const healths: string[] = [];
  const closed = vi.fn();
  relay.onClose(closed);
  const watching = relay.onHealth((health) => healths.push(health.state));
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  expect(streams[0]!.query.get('watchHealth')).toBe('1');
  frame(0, 'worker', worker);
  await watching;
  frame(0, 'health', {
    health: { state: 'connected', detail: null, since: '2026-09-25T12:00:00Z', placements: {} },
  });
  await vi.waitFor(() => expect(healths).toEqual(['connected']));
  streams[0]!.response.end();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(relay.isClosed).toBe(true);
  await expect(relay.health()).rejects.toThrow(/closed/);
});
