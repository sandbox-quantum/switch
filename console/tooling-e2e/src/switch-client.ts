/**
 * Thin client for the two Switch HTTP surfaces the harness talks to, both served
 * by the same origin (`SWITCH_API_URL`):
 *
 * - the **agent bridge** at `/agents/...`, authenticated with either the
 *   registration token (to mint an agent) or an agent's own API key (to act as
 *   that agent);
 * - the **gateway** at `/gateway/...`, authenticated with an admin bearer token
 *   from `POST /gateway/auth/login`.
 *
 * Only endpoints this harness has actually exercised against a live server are
 * modelled here; see README.md for the verified request/response shapes.
 */

export interface RegisteredAgent {
  id: string;
  name: string;
  apiKey: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  bridgeId: string | null;
  bridgeType: string | null;
  archived: boolean;
}

export interface RoomDetail extends RoomSummary {
  externalChannelId: string | null;
  matrixRoomId: string | null;
  agentIds: string[];
}

export interface AgentSummary {
  id: string;
  name: string;
}

/**
 * One event off the agent-facing notification stream.
 *
 * The message text is **`payload.body`**, not a top-level `content` — an event
 * looks like:
 *
 * ```json
 * { "type": "message", "room_id": "…", "bridge_id": "…",
 *   "channel_type": "channel_public",
 *   "payload": { "addressed": true, "sender": "@switch-mattermost-…:localhost",
 *                "sender_name": "user", "message_id": "$…",
 *                "body": "@agent hello", "timestamp": 1788…, "thread_id": null,
 *                "attachments": [] } }
 * ```
 */
export interface AgentEvent {
  type: string;
  room_id?: string;
  bridge_id?: string;
  channel_type?: string;
  payload?: {
    addressed?: boolean;
    sender?: string;
    sender_name?: string;
    message_id?: string;
    body?: string;
    timestamp?: number;
    thread_id?: string | null;
    attachments?: unknown[];
    [key: string]: unknown;
  };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The human-readable text of an event, or `''` when it carries none. */
export function eventText(event: AgentEvent): string {
  const body = event.payload?.body;
  return typeof body === 'string' ? body : '';
}

export class SwitchHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> ${status}: ${truncate(body, 400)}`);
    this.name = 'SwitchHttpError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface SwitchClientOptions {
  apiUrl: string;
  registrationToken: string;
  gatewayAdminEmail: string;
  gatewayAdminPassword: string;
}

export class SwitchClient {
  private readonly apiUrl: string;
  private readonly registrationToken: string;
  private readonly adminEmail: string;
  private readonly adminPassword: string;
  private gatewayCookie: string | null = null;

  constructor(options: SwitchClientOptions) {
    this.apiUrl = options.apiUrl;
    this.registrationToken = options.registrationToken;
    this.adminEmail = options.gatewayAdminEmail;
    this.adminPassword = options.gatewayAdminPassword;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    init: { token?: string; cookie?: string; body?: unknown; timeoutMs?: number } = {}
  ): Promise<T> {
    return (await this.rawRequest(method, path, init)).parsed as T;
  }

  private async rawRequest(
    method: string,
    path: string,
    init: { token?: string; cookie?: string; body?: unknown; timeoutMs?: number }
  ): Promise<{ parsed: unknown; response: Response }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      throw new SwitchHttpError(method, path, response.status, await response.text());
    }
    if (response.status === 204) return { parsed: undefined, response };
    const text = await response.text();
    return { parsed: text === '' ? undefined : JSON.parse(text), response };
  }

  /** `GET /health` — the reachability probe the suite skips on. */
  async health(): Promise<void> {
    const body = await this.request<{ status?: string }>('GET', '/health', {
      timeoutMs: 5_000,
    });
    if (body?.status !== 'ok') {
      throw new Error(`Switch /health returned ${JSON.stringify(body)}`);
    }
  }

  // ── gateway (admin) ───────────────────────────────────────────────────────

  /**
   * `POST /gateway/auth/login` with `{email, password}`.
   *
   * The gateway is **cookie-authenticated, not bearer-authenticated**: the
   * response body is the session user, and the credential is a `switch_auth`
   * cookie in `Set-Cookie`. Node's `fetch` has no cookie jar, so the cookie is
   * extracted here and replayed as a `Cookie` header on every gateway call.
   * Cached for the life of the client.
   */
  async gatewayLogin(): Promise<string> {
    if (this.gatewayCookie) return this.gatewayCookie;
    const { response } = await this.rawRequest('POST', '/gateway/auth/login', {
      body: { email: this.adminEmail, password: this.adminPassword },
    });
    const cookie = sessionCookieFrom(response);
    if (!cookie) {
      throw new Error(
        'Gateway login succeeded but returned no switch_auth cookie — the gateway ' +
          'authenticates with a session cookie, not a bearer token.'
      );
    }
    this.gatewayCookie = cookie;
    return cookie;
  }

  private async gateway<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, `/gateway${path}`, {
      cookie: await this.gatewayLogin(),
      body,
    });
  }

  async listRooms(): Promise<RoomSummary[]> {
    const rows = await this.gateway<RawRoom[]>('GET', '/rooms');
    return rows.map(toRoomSummary);
  }

  async getRoom(roomId: string): Promise<RoomDetail> {
    const row = await this.gateway<RawRoom>('GET', `/rooms/${roomId}`);
    return {
      ...toRoomSummary(row),
      externalChannelId: row.external_channel_id ?? null,
      matrixRoomId: row.matrix_room_id ?? null,
      agentIds: row.agent_ids ?? [],
    };
  }

  /**
   * `POST /gateway/rooms` — create a Switch room and let the bridge provision
   * the platform channel for it.
   *
   * This is the harness's room-creation path, and the choice is not arbitrary.
   * The "add the agent's bot to a channel" route relies on some *other* agent's
   * websocket witnessing the join (`_handle_user_added` in the Mattermost
   * adapter), so adding the FIRST bot to a brand-new channel is witnessed by
   * nobody and no room is ever created — verified against a live server, see
   * README.md. Creating the room here makes Switch create the channel and add
   * the bot itself, which is deterministic.
   *
   * `userNames` are platform usernames added to the channel — the harness adds
   * itself, since it has to be a channel member to post as the human.
   */
  async createRoom(params: {
    name: string;
    description: string;
    bridgeId: string;
    agentNames: string[];
    userNames?: string[];
  }): Promise<RoomDetail> {
    const row = await this.gateway<RawRoom>('POST', '/rooms', {
      name: params.name,
      description: params.description,
      bridge_id: params.bridgeId,
      agent_names: params.agentNames,
      user_names: params.userNames ?? [],
      channel_type: 'channel_public',
      internal_only: false,
    });
    return {
      ...toRoomSummary(row),
      externalChannelId: row.external_channel_id ?? null,
      matrixRoomId: row.matrix_room_id ?? null,
      agentIds: row.agent_ids ?? [],
    };
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.gateway('DELETE', `/rooms/${roomId}`);
  }

  /**
   * `DELETE /gateway/agents/by-name/{name}` — admin-authenticated teardown that,
   * unlike `DELETE /agents/{id}`, does not need the agent's own API key. Used by
   * the cleanup script for agents left behind by an interrupted run.
   */
  async deleteAgentByName(name: string): Promise<void> {
    await this.gateway('DELETE', `/agents/by-name/${encodeURIComponent(name)}`);
  }

  /**
   * The status Switch reports for one agent in one room. `live` means a session
   * is attending the room; `dormant` means an auto-session connector is watching
   * and would spawn one; `no_session` / `disconnected` mean nothing is there.
   */
  async agentStatusInRoom(roomId: string, agentId: string): Promise<string | null> {
    const row = await this.gateway<RawRoom>('GET', `/rooms/${roomId}`);
    const statuses = row.agent_statuses;
    if (!statuses || typeof statuses !== 'object') return null;
    const status = (statuses as Record<string, unknown>)[agentId];
    return typeof status === 'string' ? status : null;
  }

  async listAgents(): Promise<AgentSummary[]> {
    const rows = await this.gateway<{ id: string; name: string }[]>('GET', '/agents');
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /** The bridge id of the default collaboration bridge of `type`. */
  async defaultBridgeId(type: string): Promise<string> {
    const rows = await this.gateway<
      { id: string; bridge_type: string; is_default?: boolean; enabled?: boolean }[]
    >('GET', '/collaborations');
    const ofType = rows.filter((row) => row.bridge_type === type);
    if (ofType.length === 0) {
      throw new Error(`No ${type} collaboration bridge registered on this Switch server`);
    }
    return (ofType.find((row) => row.is_default) ?? ofType[0]!).id;
  }

  /**
   * Find the Switch room bound to a given external (Mattermost) channel id.
   * The room list does not carry `external_channel_id`, so each candidate room
   * on the bridge is read in full — the set is small on a dev server, and the
   * alternative (matching on display name) is ambiguous.
   */
  async findRoomByExternalChannel(
    bridgeId: string,
    externalChannelId: string
  ): Promise<RoomDetail | null> {
    const rooms = await this.listRooms();
    for (const room of rooms) {
      if (room.bridgeId !== bridgeId || room.archived) continue;
      const detail = await this.getRoom(room.id);
      if (detail.externalChannelId === externalChannelId) return detail;
    }
    return null;
  }

  /** Poll {@link findRoomByExternalChannel} until the bridge has created the room. */
  async waitForRoomByExternalChannel(
    bridgeId: string,
    externalChannelId: string,
    deadlineMs: number
  ): Promise<RoomDetail> {
    const until = Date.now() + deadlineMs;
    let last: RoomDetail | null = null;
    while (Date.now() < until) {
      last = await this.findRoomByExternalChannel(bridgeId, externalChannelId);
      if (last) return last;
      await sleep(2_000);
    }
    throw new Error(
      `No Switch room appeared for Mattermost channel ${externalChannelId} within ${deadlineMs}ms. ` +
        `Is the Mattermost bridge running and is the agent's bot a member of the channel?`
    );
  }

  // ── agent bridge: registration ────────────────────────────────────────────

  /**
   * Register a "known agent" (`POST /agents/register-known`, registration-token
   * auth). `agentType` is one of the gateway's known types — `opencode`,
   * `codex`, `claude-code` — and `options` is that type's option schema, which
   * for OpenCode is `{ auto_session, repo_dir }`.
   *
   * Registration is also what mints the agent's Mattermost bot account: the
   * protocol service calls `create_agent_identity` on every collaboration
   * bridge, and the Mattermost adapter creates a bot whose **username is the
   * agent name verbatim**. So the agent must be registered before its bot can
   * be added to a channel.
   */
  async registerKnownAgent(params: {
    agentType: 'opencode' | 'codex' | 'claude-code';
    name: string;
    description: string;
    options?: Record<string, unknown>;
  }): Promise<RegisteredAgent> {
    const body = await this.request<{ id: string; api_key: string }>(
      'POST',
      '/agents/register-known',
      {
        token: this.registrationToken,
        body: {
          agent_type: params.agentType,
          name: params.name,
          description: params.description,
          options: params.options ?? {},
        },
      }
    );
    return { id: body.id, name: params.name, apiKey: body.api_key };
  }

  /**
   * `DELETE /agents/{id}` authenticated as the agent itself — the registration
   * token is not accepted here, the handler compares the token's agent against
   * the path id.
   */
  async deleteAgent(agent: RegisteredAgent): Promise<void> {
    await this.request('DELETE', `/agents/${agent.id}`, { token: agent.apiKey });
  }

  // ── agent bridge: acting as an agent ──────────────────────────────────────

  /**
   * Long-poll `GET /agents/{id}/notifications?timeout=` as the agent. Returns
   * only *notifiable* events (addressed messages, task events, listened-for
   * joins) and never drains the per-room queues a live session polls, so the
   * harness can watch the same stream Switch Console's auto-session watcher
   * watches without stealing a running session's events.
   *
   * Returns `[]` on the server's 204 (nothing within the timeout).
   */
  async pollNotifications(
    agent: RegisteredAgent,
    timeoutSeconds = 10
  ): Promise<AgentEvent[]> {
    const body = await this.request<{ events?: AgentEvent[] } | undefined>(
      'GET',
      `/agents/${agent.id}/notifications?timeout=${timeoutSeconds}`,
      { token: agent.apiKey, timeoutMs: (timeoutSeconds + 15) * 1000 }
    );
    return body?.events ?? [];
  }

  /** As {@link pollNotifications}, but for one room's live event queue. */
  async pollRoomEvents(
    agent: RegisteredAgent,
    roomId: string,
    timeoutSeconds = 10
  ): Promise<AgentEvent[]> {
    const body = await this.request<{ events?: AgentEvent[] } | undefined>(
      'GET',
      `/agents/${agent.id}/rooms/${roomId}/events?timeout=${timeoutSeconds}`,
      { token: agent.apiKey, timeoutMs: (timeoutSeconds + 15) * 1000 }
    );
    return body?.events ?? [];
  }

  /**
   * Wait for a notification satisfying `predicate`, collecting everything seen
   * along the way. Returns `{ match: null, seen }` on timeout rather than
   * throwing, so a caller can report the stream it did see.
   */
  async waitForNotification(
    agent: RegisteredAgent,
    predicate: (event: AgentEvent) => boolean,
    deadlineMs: number
  ): Promise<{ match: AgentEvent | null; seen: AgentEvent[] }> {
    const until = Date.now() + deadlineMs;
    const seen: AgentEvent[] = [];
    while (Date.now() < until) {
      const remaining = Math.max(1, Math.min(10, Math.ceil((until - Date.now()) / 1000)));
      const events = await this.pollNotifications(agent, remaining);
      for (const event of events) {
        seen.push(event);
        if (predicate(event)) return { match: event, seen };
      }
    }
    return { match: null, seen };
  }

  /**
   * `GET /agents/{id}/rooms/{room_id}/history?limit=` as the agent — the room's
   * recent messages, addressed or not. Unlike the notification stream this shows
   * ordinary channel chatter, which is what makes it usable as a bridge-liveness
   * probe that does not wake the agent.
   */
  async roomHistory(
    agent: RegisteredAgent,
    roomId: string,
    limit = 20
  ): Promise<{ sender: string; sender_name: string; body: string; timestamp: number | null }[]> {
    const body = await this.request<{
      events: { sender: string; sender_name: string; body: string; timestamp: number | null }[];
    }>('GET', `/agents/${agent.id}/rooms/${roomId}/history?limit=${limit}`, {
      token: agent.apiKey,
    });
    return body.events;
  }

  /**
   * `POST /agents/{id}/message` with `{room_id, content}` — post into a room as
   * the agent. The bridge relays it to Mattermost as the agent's bot. Returns
   * the Matrix event id.
   */
  async sendMessage(
    agent: RegisteredAgent,
    roomId: string,
    content: string
  ): Promise<string> {
    const body = await this.request<{ ok: boolean; event_id: string }>(
      'POST',
      `/agents/${agent.id}/message`,
      { token: agent.apiKey, body: { room_id: roomId, content } }
    );
    return body.event_id;
  }

  /**
   * `POST /agents/{id}/watch/heartbeat` — the room-agnostic "an operator
   * connector is watching this agent" beat. Switch Console pings it while its
   * auto-session watcher is running; it is what makes the agent report DORMANT
   * rather than DISCONNECTED in rooms with no live session.
   */
  async watchHeartbeat(agent: RegisteredAgent): Promise<void> {
    await this.request('POST', `/agents/${agent.id}/watch/heartbeat`, {
      token: agent.apiKey,
      body: {},
    });
  }
}

interface RawRoom {
  id: string;
  name: string;
  bridge_id?: string | null;
  bridge_type?: string | null;
  archived?: boolean;
  external_channel_id?: string | null;
  matrix_room_id?: string | null;
  agent_ids?: string[];
  agent_statuses?: Record<string, unknown>;
}

function toRoomSummary(row: RawRoom): RoomSummary {
  return {
    id: row.id,
    name: row.name,
    bridgeId: row.bridge_id ?? null,
    bridgeType: row.bridge_type ?? null,
    archived: row.archived ?? false,
  };
}

/**
 * The `switch_auth=…` pair out of a response's `Set-Cookie` headers, ready to be
 * sent back as a `Cookie` header. Node exposes multiple `Set-Cookie` headers via
 * `getSetCookie()`; the single-header fallback covers older runtimes.
 */
export function sessionCookieFrom(response: Response): string | null {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  for (const header of raw) {
    const pair = header.split(';', 1)[0]?.trim();
    if (pair?.startsWith('switch_auth=')) return pair;
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
