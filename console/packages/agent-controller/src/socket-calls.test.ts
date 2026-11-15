import { describe, expect, it } from 'vitest';
import { type Call, SocketCallLost, SocketCalls } from './socket-calls';

const call: Call = {
  agentId: 'agent-1',
  roomId: 'room-a',
  operation: 'post_message',
  args: { body: 'hi' },
  requestId: 'request-1',
};

function opened(maxInFlight = 4) {
  const calls = new SocketCalls();
  const sent: Record<string, unknown>[] = [];
  calls.open((text) => void sent.push(JSON.parse(text) as Record<string, unknown>), maxInFlight);
  return { calls, sent };
}

describe('SocketCalls', () => {
  it('sends a call frame and resolves with the answer that names its id', async () => {
    const { calls, sent } = opened();
    const first = calls.call(call)!;
    const second = calls.call({ ...call, operation: 'read_context', roomId: null })!;

    calls.answer({ id: 2, status: 404, body: { detail: 'no' } });
    calls.answer({ id: 1, status: 200, body: { result: { event_id: '$e' } } });

    expect(sent).toEqual([
      {
        type: 'call',
        id: 1,
        agent_id: 'agent-1',
        operation: 'post_message',
        arguments: { body: 'hi' },
        room_id: 'room-a',
        request_id: 'request-1',
      },
      {
        type: 'call',
        id: 2,
        agent_id: 'agent-1',
        operation: 'read_context',
        arguments: { body: 'hi' },
        room_id: null,
        request_id: 'request-1',
      },
    ]);
    expect(await first).toEqual({ status: 200, body: { result: { event_id: '$e' } } });
    expect(await second).toEqual({ status: 404, body: { detail: 'no' } });
  });

  it('answers null while no socket that takes calls is open, so the call goes over HTTP', () => {
    expect(new SocketCalls().call(call)).toBeNull();
  });

  it('answers null once as many calls are in flight as the server takes', () => {
    const { calls, sent } = opened(1);
    expect(calls.call(call)).not.toBeNull();
    expect(calls.call(call)).toBeNull();
    calls.answer({ id: 1, status: 200, body: { result: null } });
    expect(calls.call(call)).not.toBeNull();
    expect(sent).toHaveLength(2);
  });

  it('fails every call still waiting when the socket closes, and sends no more', async () => {
    const { calls } = opened();
    const waiting = calls.call(call)!;
    calls.close('gone');

    await expect(waiting).rejects.toBeInstanceOf(SocketCallLost);
    expect(calls.call(call)).toBeNull();
  });

  it('answers null when the frame could not be sent', () => {
    const calls = new SocketCalls();
    calls.open(() => {
      throw new Error('closing');
    }, 4);
    expect(calls.call(call)).toBeNull();
  });

  it('ignores an answer to no call it is waiting on', async () => {
    const { calls } = opened();
    const waiting = calls.call(call)!;
    calls.answer({ id: 'c-7', status: 200, body: null });
    calls.answer({ id: 9, status: 200, body: null });
    calls.answer({ id: 1, status: 201, body: null });
    expect(await waiting).toEqual({ status: 201, body: null });
  });
});
