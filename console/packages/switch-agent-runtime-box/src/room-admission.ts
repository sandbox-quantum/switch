import type { SwitchCredentials } from './types';

/**
 * Asking Switch which session of an agent a room delivery belongs to.
 *
 * The agent's controller holds one inbound connection and has to decide, for
 * every addressed room message, which of its sessions the message goes to and
 * whether a new one may be started for it. That answer is the server's: it
 * knows which session currently holds the room, and it is the only place two
 * controllers — or two deliveries seconds apart — can be serialized against
 * each other. Worked out locally it is read from session files that outlive
 * the sessions that wrote them, so a stopped session goes on claiming a room
 * it left and the message reaches nobody.
 *
 * The server also keeps the verified delivery while it waits, so a message
 * held for a room with no owner survives the replay buffer being trimmed.
 * Those are the reservations below.
 */

/** A room delivery, named by its message rather than by where it arrived. */
export interface RoomDelivery {
  roomId: string;
  messageId: string;
}

/**
 * Who the delivery belongs to.
 *
 * - `owner` — a running session holds the room; the delivery goes to it.
 * - `unavailable` — the room is spoken for by something that cannot take the
 *   delivery yet, or nothing holds it and this controller may not start one.
 *   The delivery waits and the question is asked again. `stalled` is set where
 *   the room is held by one unfinished session whose host was killed: it names
 *   the session that would have to come back for the room to be served again,
 *   and is null wherever the wait is something else — a grant already issued,
 *   or a controller that may not start a session.
 * - `none` — nothing holds the room, and this answer carries the right to
 *   start exactly one session for it. The right lapses at `grantExpiresAt`.
 */
export type RoomAdmission =
  | { status: 'owner'; sessionId: string; hostId: string; epoch: string }
  | { status: 'unavailable'; stalled: { sessionId: string; hostId: string } | null }
  | { status: 'none'; grantExpiresAt: string };

/** A verified delivery the server is still holding for this agent. */
export interface RoomReservation extends RoomDelivery {
  sequence: number;
  /** The server has stopped promising it. It is kept until given up on. */
  expired: boolean;
}

/** A room a session was serving that the server would not record for it. */
export interface RefusedRoom {
  roomId: string;
  reason: string;
}

/**
 * What the server recorded of the rooms this agent's sessions were serving on
 * connections of their own.
 *
 * `unverifiable` names sessions the server could decide neither way: live, and
 * bound to a connection it cannot see. Nothing was carried for them and
 * nothing is known to have been lost, which is not the same as having nothing
 * to carry.
 */
export interface CarriedRooms {
  sessions: { sessionId: string; adopted: string[]; refused: RefusedRoom[] }[];
  unverifiable: string[];
}

/**
 * A refusal, or a server that could not be reached.
 *
 * `retryable` is the one thing a caller must branch on. A delivery refused for
 * what it is will be refused again however long it waits, and holding it
 * forever is how a room goes quiet with nobody saying why; one refused because
 * the server is unreachable is the opposite, and dropping it loses a message.
 */
export class RoomAdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'RoomAdmissionError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Refusals that say "not now" rather than "no".
 *
 * The status alone cannot carry this: a conflict is normally the server's
 * final answer, and one of these is the opposite — state that moved while the
 * server was deciding, which the next attempt reads afresh.
 */
const RETRYABLE_CODES = new Set(['CLAIM_MOVED']);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new RoomAdmissionError(
      'INVALID_RESPONSE',
      `Switch answered a room admission without ${field}.`,
      false
    );
  return value;
}

export class SwitchRoomAdmissions {
  constructor(private readonly creds: SwitchCredentials) {}

  private async request(
    path: string,
    body: unknown | undefined,
    signal: AbortSignal
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.creds.apiEndpoint}/sessions/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${this.creds.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RoomAdmissionError('UNREACHABLE', `Switch is unreachable: ${String(error)}`, true);
    }
    if (!response.ok) {
      const detail = await response.text();
      let code = '';
      try {
        code = String((JSON.parse(detail) as { code?: unknown }).code ?? '');
      } catch {
        /* The response may be plain text. */
      }
      throw new RoomAdmissionError(
        code || `HTTP_${response.status}`,
        `Switch refused a room admission (${response.status}): ${detail}`,
        RETRYABLE_CODES.has(code) || [408, 425, 429, 500, 502, 503, 504].includes(response.status)
      );
    }
    return response.json();
  }

  /**
   * Ask which session the delivery belongs to.
   *
   * `spawning` is whether this controller may start a session, and it travels
   * with the delivery rather than with the controller: the setting can be
   * turned off while a message waits, and the permission it arrived under is
   * the one it is finally admitted on.
   */
  async admit(
    delivery: RoomDelivery & { sequence: number; spawning: boolean },
    signal: AbortSignal
  ): Promise<RoomAdmission> {
    const answer = await this.request(
      'room-admission',
      {
        room_id: delivery.roomId,
        message_id: delivery.messageId,
        sequence: delivery.sequence,
        spawning: delivery.spawning,
      },
      signal
    );
    if (typeof answer !== 'object' || answer === null)
      throw new RoomAdmissionError('INVALID_RESPONSE', 'Switch answered no admission.', false);
    const body = answer as Record<string, unknown>;
    if (body.status === 'owner')
      return {
        status: 'owner',
        sessionId: text(body.session_id, 'the session that holds the room'),
        hostId: text(body.host_id, "the room owner's host"),
        epoch: text(body.epoch, "the room owner's epoch"),
      };
    if (body.status === 'unavailable')
      return {
        status: 'unavailable',
        stalled:
          body.session_id === null || body.session_id === undefined
            ? null
            : {
                sessionId: text(body.session_id, 'the session that holds the room'),
                hostId: text(body.host_id, "the stalled session's host"),
              },
      };
    if (body.status === 'none')
      return {
        status: 'none',
        grantExpiresAt: text(body.grant_expires_at, 'an expiry for the right it grants'),
      };
    throw new RoomAdmissionError(
      'INVALID_RESPONSE',
      `Switch answered an unknown room admission status: ${String(body.status)}`,
      false
    );
  }

  /**
   * Have the server record which of this agent's sessions is serving which
   * room, for the sessions still serving themselves.
   *
   * Asked before the sessions started by an older build are replaced, because
   * what answers it is the connection each of them is still holding: the rooms
   * the server is subscribed to on that connection are the rooms it is already
   * delivering to that session. Once the worker is gone so is the answer.
   *
   * `connectionId` is this controller's own, and only says which sessions are
   * already on it. What a session is given comes from its own connection.
   */
  async carryRooms(connectionId: string, signal: AbortSignal): Promise<CarriedRooms> {
    const answer = await this.request(
      'carry-connection-rooms',
      { connection_id: connectionId },
      signal
    );
    const body = (answer ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.sessions) || !Array.isArray(body.unverifiable))
      throw new RoomAdmissionError(
        'INVALID_RESPONSE',
        'Switch answered no account of the rooms its sessions were serving.',
        false
      );
    return {
      sessions: body.sessions.map((entry) => {
        const row = entry as Record<string, unknown>;
        if (!Array.isArray(row.adopted) || !Array.isArray(row.refused))
          throw new RoomAdmissionError(
            'INVALID_RESPONSE',
            'Switch answered an unreadable account of a session.',
            false
          );
        return {
          sessionId: text(row.sessionId, 'the session it carried rooms for'),
          adopted: row.adopted.map((room) => text(room, 'a room it recorded')),
          refused: row.refused.map((room) => {
            const refusal = room as Record<string, unknown>;
            return {
              roomId: text(refusal.roomId, 'a room it did not record'),
              reason: text(refusal.reason, 'a reason it did not record a room'),
            };
          }),
        };
      }),
      unverifiable: body.unverifiable.map((session) =>
        text(session, 'a session it could not decide')
      ),
    };
  }

  /** The verified deliveries the server is still holding for this agent. */
  async reservations(signal: AbortSignal): Promise<RoomReservation[]> {
    const answer = await this.request('room-reservations', undefined, signal);
    if (!Array.isArray(answer))
      throw new RoomAdmissionError(
        'INVALID_RESPONSE',
        'Switch answered no room reservations.',
        false
      );
    return answer.map((entry) => {
      const row = entry as Record<string, unknown>;
      if (
        typeof row.sequence !== 'number' ||
        !Number.isInteger(row.sequence) ||
        typeof row.expired !== 'boolean'
      )
        throw new RoomAdmissionError(
          'INVALID_RESPONSE',
          'Switch answered an unreadable room reservation.',
          false
        );
      return {
        roomId: text(row.room_id, 'a room'),
        messageId: text(row.message_id, 'a message'),
        sequence: row.sequence,
        expired: row.expired,
      };
    });
  }

  /**
   * Give up a held delivery, so the server stops keeping its copy.
   *
   * Separate from expiry on purpose. Expiry stops the server promising the
   * delivery; it does not throw the copy away, because the controller may
   * still be holding the message and about to ask about it. The copy goes when
   * the controller says it has stopped.
   */
  async discard(delivery: RoomDelivery, signal: AbortSignal): Promise<void> {
    await this.request(
      'room-reservations/discard',
      { room_id: delivery.roomId, message_id: delivery.messageId },
      signal
    );
  }
}
