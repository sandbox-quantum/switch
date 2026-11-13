import { afterEach, expect, it, vi } from 'vitest';
import { RoomAdmissionError, SwitchRoomAdmissions } from './room-admission';

/**
 * The controller acts on these answers without a second opinion: it routes a
 * message to the session named here, or starts one on the strength of a grant.
 * So an answer it cannot read has to be a refusal rather than a shape it
 * guesses at — and a refusal has to say whether asking again could ever change
 * it, because holding a message for ever and dropping one are both wrong.
 */

const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test/agent', token: 'tok' };
const delivery = { roomId: 'room-1', messageId: 'message-1', sequence: 4, spawning: true };

function answering(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const live = () => new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
});

it('asks the agent bridge about one delivery and reads back who holds the room', async () => {
  const fetchMock = answering(200, {
    status: 'owner',
    session_id: 'session-1',
    host_id: 'host-1',
    epoch: 'epoch-1',
  });

  const answer = await new SwitchRoomAdmissions(creds).admit(delivery, live());

  expect(answer).toEqual({
    status: 'owner',
    sessionId: 'session-1',
    hostId: 'host-1',
    epoch: 'epoch-1',
  });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://switch.test/agent/sessions/room-admission');
  expect(JSON.parse(String(init.body))).toEqual({
    room_id: 'room-1',
    message_id: 'message-1',
    sequence: 4,
    spawning: true,
  });
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  // A redirect is not an answer about this agent's rooms: following one would
  // send the token somewhere this client never chose to talk to.
  expect(init.redirect).toBe('error');
});

it('reads the right to start a session, and how long it lasts', async () => {
  answering(200, { status: 'none', grant_expires_at: '2026-01-01T00:02:00Z' });

  expect(await new SwitchRoomAdmissions(creds).admit(delivery, live())).toEqual({
    status: 'none',
    grantExpiresAt: '2026-01-01T00:02:00Z',
  });
});

it('reads which session a room is waiting on, and takes no answer as none', async () => {
  answering(200, { status: 'unavailable', session_id: 'session-1', host_id: 'host-1' });

  expect(await new SwitchRoomAdmissions(creds).admit(delivery, live())).toEqual({
    status: 'unavailable',
    stalled: { sessionId: 'session-1', hostId: 'host-1' },
  });

  // The wait is something else — a grant already issued, or a controller that
  // may not start a session. There is nothing here to bring back.
  answering(200, { status: 'unavailable', session_id: null, host_id: null });
  expect(await new SwitchRoomAdmissions(creds).admit(delivery, live())).toEqual({
    status: 'unavailable',
    stalled: null,
  });
});

it('refuses a half-named stalled session rather than starting from a guess', async () => {
  answering(200, { status: 'unavailable', session_id: 'session-1', host_id: null });

  await expect(new SwitchRoomAdmissions(creds).admit(delivery, live())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    retryable: false,
  });
});

it('refuses a grant with no expiry rather than acting on one that never lapses', async () => {
  answering(200, { status: 'none' });

  await expect(new SwitchRoomAdmissions(creds).admit(delivery, live())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    retryable: false,
  });
});

it('refuses an owner it cannot address', async () => {
  // Enough of an answer to look like one, and not enough to route with: a
  // handoff written for a session named by nothing reaches nobody.
  answering(200, { status: 'owner', session_id: 'session-1', host_id: 'host-1' });

  await expect(new SwitchRoomAdmissions(creds).admit(delivery, live())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    retryable: false,
  });
});

it('refuses a status it does not know rather than treating it as a free room', async () => {
  answering(200, { status: 'maybe' });

  await expect(new SwitchRoomAdmissions(creds).admit(delivery, live())).rejects.toThrow('maybe');
});

it('carries the refusal code the server gave, and says asking again will not help', async () => {
  answering(404, { code: 'NOT_FOUND', message: 'No such room message.' });

  const refusal = await new SwitchRoomAdmissions(creds)
    .admit(delivery, live())
    .catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(RoomAdmissionError);
  expect(refusal).toMatchObject({ code: 'NOT_FOUND', retryable: false });
  expect(String(refusal)).toContain('No such room message.');
});

it('says a delivery refused while the server is busy is worth asking about again', async () => {
  answering(503, 'upstream unavailable');

  await expect(new SwitchRoomAdmissions(creds).admit(delivery, live())).rejects.toMatchObject({
    code: 'HTTP_503',
    retryable: true,
  });
});

it('says a server it could not reach is worth asking about again', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('connection refused');
    })
  );

  await expect(new SwitchRoomAdmissions(creds).admit(delivery, live())).rejects.toMatchObject({
    code: 'UNREACHABLE',
    retryable: true,
  });
});

it('lets the caller abort rather than reporting its own shutdown as a failure', async () => {
  const abort = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      abort.abort(new Error('the controller is stopping'));
      init.signal?.throwIfAborted();
      throw new Error('unreachable');
    })
  );

  const error = await new SwitchRoomAdmissions(creds)
    .admit(delivery, abort.signal)
    .catch((thrown: unknown) => thrown);

  expect(error).not.toBeInstanceOf(RoomAdmissionError);
});

it('reads back what the server is still holding for this agent', async () => {
  const fetchMock = answering(200, [
    { room_id: 'room-1', message_id: 'message-1', sequence: 4, expired: false },
    { room_id: 'room-2', message_id: 'message-2', sequence: 9, expired: true },
  ]);

  expect(await new SwitchRoomAdmissions(creds).reservations(live())).toEqual([
    { roomId: 'room-1', messageId: 'message-1', sequence: 4, expired: false },
    { roomId: 'room-2', messageId: 'message-2', sequence: 9, expired: true },
  ]);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://switch.test/agent/sessions/room-reservations');
  expect(init.method).toBe('GET');
});

it('refuses a reservation it cannot read rather than giving up on the rest', async () => {
  // Dropping the unreadable one quietly is how a held message disappears: the
  // controller would stop re-driving it and the server would go on keeping it.
  answering(200, [{ room_id: 'room-1', message_id: 'message-1', sequence: 4 }]);

  await expect(new SwitchRoomAdmissions(creds).reservations(live())).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    retryable: false,
  });
});

it('names the delivery it is giving up on', async () => {
  const fetchMock = answering(200, {});

  await new SwitchRoomAdmissions(creds).discard(
    { roomId: 'room-1', messageId: 'message-1' },
    live()
  );

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://switch.test/agent/sessions/room-reservations/discard');
  expect(JSON.parse(String(init.body))).toEqual({
    room_id: 'room-1',
    message_id: 'message-1',
  });
});
