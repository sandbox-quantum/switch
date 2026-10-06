import { randomUUID } from 'node:crypto';

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
 * One room event off the agent's event stream (`GET /agents/{id}/events` as
 * server-sent events).
 *
 * The message text is **`payload.body`**, not a top-level `content` — an event
 * looks like:
 *
 * ```json
 * { "type": "message", "room_id": "…", "bridge_id": "…",
 *   "channel_type": "channel_public", "sequence": 42,
 *   "payload": { "addressed": true, "sender": "@switch-mattermost-…:localhost",
 *                "sender_name": "user", "message_id": "$…",
 *                "body": "@agent hello", "timestamp": 1788…, "thread_id": null,
 *                "attachments": [] } }
 * ```
 */
export interface AgentEvent {
  type: string;
  room_id?: string;
  sequence?: number;
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
   * `DELETE /gateway/agents/by-name/{name}` — admin-authenticated teardown that
   * does not need the agent's own API key, so it also serves the cleanup script
   * for agents left behind by an interrupted run.
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
    agentType: 'opencode' | 'codex' | 'claude-code' | 'antigravity' | 'cursor';
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

  // ── agent bridge: acting as an agent ──────────────────────────────────────

  /**
   * Open the agent's event stream and hold its connection alive: `GET
   * /agents/{id}/events` with `Accept: text/event-stream`, `scope=all` and
   * `filter=addressed`, so it carries what wakes the agent — addressed messages
   * and listened-for joins — across every room no live session has claimed.
   *
   * The stream starts at head, so only events after this resolves are seen:
   * open it before posting the message a test waits for. Resolves once the
   * server's `connection_state` frame has arrived. Close it when done, or the
   * connection lingers until its heartbeat lapses.
   */
  async watchAddressedEvents(agent: RegisteredAgent): Promise<EventWatcher> {
    const connectionId = randomUUID();
    const path =
      `/agents/${agent.id}/events?connection_id=${connectionId}` +
      '&scope=all&filter=addressed&start_from=head';
    const controller = new AbortController();
    const response = await fetch(`${this.apiUrl}${path}`, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${agent.apiKey}` },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      controller.abort();
      throw new SwitchHttpError('GET', path, response.status, await response.text());
    }
    const watcher = new EventWatcher(response.body, controller, (cursor, generation) =>
      this.request('POST', `/agents/${agent.id}/connection/beat`, {
        token: agent.apiKey,
        body: { connection_id: connectionId, cursor, generation },
      })
    );
    await watcher.opened(30_000);
    return watcher;
  }

  /**
   * The room's recent messages, addressed or not, oldest first — read through
   * the `read_context` operation (`POST /agents/{id}/ops/read_context`) as the
   * agent. Unlike the event stream this shows ordinary channel chatter, which
   * is what makes it usable as a bridge-liveness probe that does not wake the
   * agent. Entries without a body are left out.
   */
  async roomHistory(
    agent: RegisteredAgent,
    roomId: string,
    limit: number
  ): Promise<RoomHistoryEntry[]> {
    const { result } = await this.request<{ result: ReadContextResult }>(
      'POST',
      `/agents/${agent.id}/ops/read_context`,
      { token: agent.apiKey, body: { room_id: roomId, limit } }
    );
    return result.threads
      .flatMap((thread) => [thread.root, ...thread.replies])
      .filter((entry) => typeof entry.body === 'string' && entry.body !== '')
      .map((entry) => ({
        sender: entry.sender,
        sender_name: entry.sender_name,
        body: entry.body as string,
        timestamp: entry.timestamp ?? null,
      }))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  /**
   * `POST /agents/{id}/message` with `{room_id, content}` — post into a room as
   * the agent. The bridge relays it to Mattermost as the agent's bot. Returns
   * the Matrix event id.
   */
  async sendMessage(agent: RegisteredAgent, roomId: string, content: string): Promise<string> {
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

export interface RoomHistoryEntry {
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number | null;
}

interface ReadContextEntry {
  id: string;
  kind: string;
  sender: string;
  sender_name: string;
  body?: string | null;
  timestamp?: number | null;
}

interface ReadContextResult {
  threads: { root: ReadContextEntry; replies: ReadContextEntry[] }[];
}

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/**
 * One server-sent-events frame, from the text between two blank lines. `null`
 * for a frame with no data, which is what a `: keepalive` comment is.
 */
export function parseSseFrame(block: string): SseFrame | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { id, event, data: data.join('\n') };
}

type Beat = (cursor: number, generation: number | null) => Promise<unknown>;

/**
 * A live agent event stream, collecting its room events.
 *
 * Room events are the frames that carry a sequence (`id:`); the control frames
 * beside them carry none and are ignored, except `connection_state`, which
 * starts the heartbeat, and `evicted`, which ends the stream. The heartbeat
 * (`POST /agents/{id}/connection/beat`) reports the last sequence seen and the
 * stream's generation; without it the server closes the stream within seconds.
 *
 * The stream ending for any reason other than {@link close} is a failure, and
 * {@link waitFor} throws it rather than reporting a quiet stream.
 */
export class EventWatcher {
  private readonly controller: AbortController;
  private readonly beat: Beat;
  private readonly events: AgentEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private cursor = 0;
  private generation: number | null = null;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private ended: Error | null = null;

  constructor(body: ReadableStream<Uint8Array>, controller: AbortController, beat: Beat) {
    this.controller = controller;
    this.beat = beat;
    void this.pump(body);
  }

  /** Resolve once the server has sent `connection_state`; throw if the stream ends first. */
  async opened(deadlineMs: number): Promise<void> {
    const until = Date.now() + deadlineMs;
    while (!this.connected) {
      if (this.ended) throw this.ended;
      const remaining = until - Date.now();
      if (remaining <= 0) {
        this.end(new Error(`no connection_state frame within ${deadlineMs}ms`));
        throw this.ended;
      }
      await this.changed(remaining);
    }
  }

  /**
   * Wait for a room event satisfying `predicate` among everything the stream
   * has carried since it opened. Returns `{ match: null, seen }` on timeout
   * rather than throwing, so a caller can report the stream it did see.
   */
  async waitFor(
    predicate: (event: AgentEvent) => boolean,
    deadlineMs: number
  ): Promise<{ match: AgentEvent | null; seen: AgentEvent[] }> {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const match = this.events.find(predicate) ?? null;
      if (match) return { match, seen: [...this.events] };
      if (this.ended) throw this.ended;
      const remaining = until - Date.now();
      if (remaining <= 0) return { match: null, seen: [...this.events] };
      await this.changed(remaining);
    }
  }

  close(): void {
    this.end(new Error('event watcher closed'));
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffered.indexOf('\n\n')) !== -1) {
          const frame = parseSseFrame(buffered.slice(0, boundary));
          buffered = buffered.slice(boundary + 2);
          if (frame) this.onFrame(frame);
        }
      }
      this.end(new Error('the server closed the event stream'));
    } catch (error) {
      this.end(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onFrame(frame: SseFrame): void {
    const data = JSON.parse(frame.data) as Record<string, unknown>;
    if (frame.event === 'connection_state') {
      this.generation = typeof data.generation === 'number' ? data.generation : null;
      if (typeof data.cursor === 'number') this.cursor = data.cursor;
      const seconds =
        typeof data.heartbeat_interval_seconds === 'number' ? data.heartbeat_interval_seconds : 2;
      this.connected = true;
      this.scheduleBeat(seconds * 1000);
    } else if (frame.event === 'evicted') {
      this.end(new Error(`evicted from the event stream: ${frame.data}`));
      return;
    } else if (frame.id !== null) {
      this.cursor = Number(frame.id);
      this.events.push(data as AgentEvent);
    }
    this.notify();
  }

  private scheduleBeat(intervalMs: number): void {
    this.beatTimer = setTimeout(() => {
      this.beat(this.cursor, this.generation).then(
        () => {
          if (!this.ended) this.scheduleBeat(intervalMs);
        },
        (error: unknown) => this.end(new Error(`connection heartbeat refused: ${String(error)}`))
      );
    }, intervalMs);
  }

  private end(reason: Error): void {
    if (this.ended) return;
    this.ended = reason;
    if (this.beatTimer) clearTimeout(this.beatTimer);
    this.controller.abort();
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private changed(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.listeners.add(done);
    });
  }
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
