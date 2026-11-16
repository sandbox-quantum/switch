import type { CallResult } from './schemas';

/** A call's answer: the status and body the operation's HTTP route would have answered with. */
export type CallAnswer = { status: number; body: unknown };

export type Call = {
  agentId: string;
  /** The calling session's room, as `X-Switch-Room-Id` names it over HTTP. */
  roomId: string | null;
  operation: string;
  args: Record<string, unknown>;
  requestId: string | null;
};

/** The socket closed with the call unanswered: it may or may not have run. */
export class SocketCallLost extends Error {}

/**
 * The agents' operations, sent as calls on the controller's socket.
 *
 * Every operation an agent host calls (`POST /agents/{id}/ops/{operation}`)
 * reaches the relay, which would send it to Switch as an HTTP request of its
 * own. A server whose socket takes calls says so in its first frame
 * (`calls`); the relay then sends each operation here, as a `call` frame on
 * the socket the controller already holds, and Switch answers it on the
 * same socket with the status and body the HTTP route would have.
 *
 * `call` answers null when the operation has to go over HTTP instead: no
 * socket that takes calls is open, or as many calls are in flight as the
 * server takes. A call the socket closes on fails, as an HTTP request does
 * when its connection drops.
 */
export class SocketCalls {
  private send: ((text: string) => void) | null = null;
  private maxInFlight = 0;
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (answer: CallAnswer) => void; reject: (error: Error) => void }
  >();

  /** A socket that takes calls is open; `send` sends a text frame on it. */
  open(send: (text: string) => void, maxInFlight: number): void {
    this.send = send;
    this.maxInFlight = maxInFlight;
  }

  /** The socket closed: every call still waiting on it fails. */
  close(reason: string): void {
    this.send = null;
    const lost = new SocketCallLost(reason);
    for (const { reject } of this.waiting.values()) reject(lost);
    this.waiting.clear();
  }

  /** An answer arrived on the socket. */
  answer(result: CallResult): void {
    if (typeof result.id !== 'number') return;
    const waiting = this.waiting.get(result.id);
    if (!waiting) return;
    this.waiting.delete(result.id);
    waiting.resolve({ status: result.status, body: result.body });
  }

  /** Sends the call, or answers null when it has to go over HTTP instead. */
  call(call: Call): Promise<CallAnswer> | null {
    const send = this.send;
    if (!send || this.waiting.size >= this.maxInFlight) return null;
    const id = this.nextId++;
    const answered = new Promise<CallAnswer>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
    });
    try {
      send(
        JSON.stringify({
          type: 'call',
          id,
          agent_id: call.agentId,
          operation: call.operation,
          arguments: call.args,
          room_id: call.roomId,
          request_id: call.requestId,
        })
      );
    } catch {
      // The frame did not leave, so the call did not run.
      this.waiting.delete(id);
      return null;
    }
    return answered;
  }
}
