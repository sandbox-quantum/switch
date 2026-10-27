import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Environment, SwitchEnv } from "../core/env.ts";
import { assertAllowed } from "../core/guard.ts";
import type { IssuedSecrets } from "../core/secrets.ts";

/**
 * Thin client for the two Switch HTTP surfaces the harness talks to, both served
 * by the same origin (`SWITCH_API_URL`):
 *
 * - the **agent bridge** at `/agents/...`, authenticated with either the
 *   registration token (to mint an agent) or an agent's own API key (to act as
 *   that agent);
 * - the **gateway** at `/gateway/...`, authenticated with the session cookie
 *   from `POST /gateway/auth/login`.
 *
 * Every request passes the read-only guard first (`core/guard.ts`).
 *
 * Only endpoints this harness has actually exercised against a live server are
 * modelled here; see README.md for the verified request/response shapes.
 */

export interface AgentRef {
  id: string;
  name: string;
}

export interface RegisteredAgent extends AgentRef {
  apiKey: string;
}

/** The shared-session part of the gateway's agent detail. */
export interface SharedSessionDetail {
  home_room_id: string | null;
  shared_by_default: boolean;
  sharing_locked: boolean;
  rooms: { room_id: string; shared_session: "home" | "shared" | null }[];
}

export interface RoomSummary {
  id: string;
  name: string;
  createdAt: string;
  bridgeId: string | null;
  bridgeType: string | null;
  archived: boolean;
}

export interface RoomDetail extends RoomSummary {
  externalChannelId: string | null;
  matrixRoomId: string | null;
  agentIds: string[];
}

/** The management API's agent definition (v1), as much of it as the harness sets. */
export interface ManagedAgentDefinition {
  provider: string;
  model: string | null;
  instructions: string;
  auto_mode: boolean;
  auto_approve: boolean;
  directory: string | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  createdAt: string;
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
/** One row of `GET /gateway/tenants/{tenant_id}/usage`: an amount per metric, client and model. */
export interface UsageTotal {
  metric: string;
  clientId: string;
  clientName: string | null;
  model: string;
  amount: number;
}

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
  return typeof body === "string" ? body : "";
}

/** What a route answered to a probe: its status, and what it said its body was. */
export interface RouteProbe {
  status: number;
  contentType: string;
  /** The `X-Request-Id` the request carried, which the server's log lines for it name; null untagged. */
  requestId: string | null;
}

export class SwitchHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> ${status}: ${truncate(body, 400)}`);
    this.name = "SwitchHttpError";
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
  }
}

/**
 * The reason code of a management API refusal (`{"error": {"code": …}}`), or
 * null when the error is not one.
 */
export function managementErrorCode(error: unknown): string | null {
  if (!(error instanceof SwitchHttpError)) return null;
  try {
    const parsed = JSON.parse(error.body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface SwitchRequest {
  token?: string;
  cookie?: string;
  body?: unknown;
  timeoutMs?: number;
}

export class SwitchClient {
  private readonly apiUrl: string;
  /** The deployment-wide registration key; agents it registers belong to a bootstrap account. */
  private readonly registrationToken: string;
  private readonly adminEmail: string;
  private readonly adminPassword: string;
  private readonly environment: Environment;
  private readonly issued: IssuedSecrets;
  private gatewayCookie: string | null = null;
  // Shared with every client `as()` makes, so one scenario's requests carry
  // one tag, numbered without repeats, whichever user sent them.
  private tagging: { tag: string | null; count: number } = {
    tag: null,
    count: 0,
  };

  constructor(env: SwitchEnv, environment: Environment, issued: IssuedSecrets) {
    this.apiUrl = env.apiUrl;
    this.registrationToken = env.agentRegistrationToken;
    this.adminEmail = env.gatewayAdminEmail;
    this.adminPassword = env.gatewayAdminPassword;
    this.environment = environment;
    this.issued = issued;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  /**
   * Tag every request from now on with `X-Request-Id: <tag>-<n>`, which the
   * server stamps on each log line it writes while serving it. `null` stops.
   */
  tagRequests(tag: string | null): void {
    this.tagging.tag = tag;
    this.tagging.count = 0;
  }

  private requestId(): Record<string, string> {
    if (this.tagging.tag === null) return {};
    this.tagging.count += 1;
    return { "X-Request-Id": `${this.tagging.tag}-${this.tagging.count}` };
  }

  private async request<T>(
    method: string,
    path: string,
    init: SwitchRequest = {},
  ): Promise<T> {
    return (await this.rawRequest(method, path, init)).parsed as T;
  }

  private async rawRequest(
    method: string,
    path: string,
    init: SwitchRequest,
  ): Promise<{ parsed: unknown; response: Response }> {
    assertAllowed(this.environment, method, path);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.requestId(),
    };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      throw new SwitchHttpError(
        method,
        path,
        response.status,
        await response.text(),
      );
    }
    if (response.status === 204) return { parsed: undefined, response };
    const text = await response.text();
    return { parsed: text === "" ? undefined : JSON.parse(text), response };
  }

  /**
   * The status a request with no credential at all gets: no cookie, no bearer
   * key, no body. For the check that every route which takes a session refuses
   * a request without one.
   */
  async statusWithoutCredentials(
    method: string,
    path: string,
  ): Promise<RouteProbe> {
    return this.probe(method, path, null);
  }

  /**
   * What a request with this client's signed-in session, and no body, gets:
   * its status and content type. For the check that one workspace's member
   * is refused another workspace's resources.
   */
  async statusWithSession(method: string, path: string): Promise<RouteProbe> {
    return this.probe(method, path, await this.gatewayLogin());
  }

  private async probe(
    method: string,
    path: string,
    cookie: string | null,
  ): Promise<RouteProbe> {
    if (method === "WS") return this.upgradeProbe(path, cookie);
    assertAllowed(this.environment, method, path);
    const tag = this.requestId();
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
        ...tag,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      requestId: tag["X-Request-Id"] ?? null,
    };
  }

  /**
   * A WebSocket route's answer to its opening handshake: `fetch` cannot send
   * an upgrade, so this is the raw HTTP request a client's socket starts with.
   * A refused handshake answers with an ordinary status (401 without a
   * session); an accepted one answers 101, and the socket is dropped at once.
   */
  private upgradeProbe(path: string, cookie: string | null): Promise<RouteProbe> {
    // The handshake is a GET, and a refused one changes nothing.
    assertAllowed(this.environment, "GET", path);
    const tag = this.requestId();
    const url = new URL(`${this.apiUrl}${path}`);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const request = send(url, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          ...(cookie === null ? {} : { Cookie: cookie }),
          ...tag,
        },
        timeout: 30_000,
      });
      const requestId = tag["X-Request-Id"] ?? null;
      request.on("response", (response) => {
        response.resume();
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"] ?? "",
          requestId,
        });
      });
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve({ status: response.statusCode ?? 101, contentType: "", requestId });
      });
      request.on("timeout", () => request.destroy(new Error(`No answer to the handshake on ${path}`)));
      request.on("error", reject);
      request.end();
    });
  }

  /**
   * The same server, signed in as someone else. Shares this client's record of
   * issued credentials, so the other session is scanned for too, and its
   * request tagging, so a scenario observing this client sees the other's
   * requests as its own.
   */
  as(email: string, password: string): SwitchClient {
    const other = new SwitchClient(
      {
        apiUrl: this.apiUrl,
        agentRegistrationToken: this.registrationToken,
        gatewayAdminEmail: email,
        gatewayAdminPassword: password,
      },
      this.environment,
      this.issued,
    );
    other.tagging = this.tagging;
    return other;
  }

  /** `POST /gateway/users` — a user in the signed-in admin's workspace. `role: 'admin'` makes a deployment operator. */
  async createUser(params: {
    name: string;
    email: string;
    password: string;
    role: "user" | "admin";
  }): Promise<{ id: string }> {
    return this.gateway<{ id: string }>("POST", "/users", params);
  }

  /**
   * `POST /gateway/tenants` — create a workspace. The caller becomes its owner
   * and the server re-mints their session into it, so from here on this client
   * acts in the new workspace.
   */
  async createTenant(name: string): Promise<string> {
    const { parsed, response } = await this.rawRequest(
      "POST",
      "/gateway/tenants",
      {
        cookie: await this.gatewayLogin(),
        body: { name },
      },
    );
    const cookie = sessionCookieFrom(response);
    if (!cookie)
      throw new Error(
        "Creating a workspace returned no switch_auth cookie for it.",
      );
    this.issued.record(cookie.slice("switch_auth=".length));
    this.gatewayCookie = cookie;
    return (parsed as { id: string }).id;
  }

  /** `POST /gateway/agents/register` — an agent owned by the signed-in user, in their current workspace. */
  async registerAgentAsUser(params: {
    name: string;
    description: string;
  }): Promise<RegisteredAgent> {
    const body = await this.gateway<{ id: string; api_key: string }>(
      "POST",
      "/agents/register",
      {
        agent_type: "opencode",
        name: params.name,
        description: params.description,
        options: { auto_session: false },
      },
    );
    this.issued.record(body.api_key);
    return { id: body.id, name: params.name, apiKey: body.api_key };
  }

  /**
   * `PUT /gateway/agents/{id}/shared-session` — set where an agent's shared
   * session is based (`homeRoomId`, or `clearHome` to stop it sharing) and its
   * defaults for new rooms. Returns the agent's detail as the server now holds
   * it: its home room and, per room, whether that room shares the session.
   */
  async updateSharedSession(
    agentId: string,
    change: {
      homeRoomId?: string;
      clearHome?: boolean;
      sharedByDefault?: boolean;
      locked?: boolean;
    },
  ): Promise<SharedSessionDetail> {
    return this.gateway<SharedSessionDetail>(
      "PUT",
      `/agents/${agentId}/shared-session`,
      {
        ...(change.homeRoomId !== undefined
          ? { home_room_id: change.homeRoomId }
          : {}),
        ...(change.clearHome ? { clear_home: true } : {}),
        ...(change.sharedByDefault !== undefined
          ? { shared_by_default: change.sharedByDefault }
          : {}),
        ...(change.locked !== undefined ? { locked: change.locked } : {}),
      },
    );
  }

  /**
   * `PUT /gateway/agents/{id}/rooms/{room}/session` — have one room share the
   * agent's session, or give it a session of its own.
   */
  async setRoomSession(
    agentId: string,
    roomId: string,
    shared: boolean,
  ): Promise<SharedSessionDetail> {
    return this.gateway<SharedSessionDetail>(
      "PUT",
      `/agents/${agentId}/rooms/${roomId}/session`,
      { shared },
    );
  }

  /** `GET /gateway/feature-flags` — the flags this deployment has turned on. */
  async enabledFeatureFlags(): Promise<Set<string>> {
    const body = await this.gateway<{
      flags: { key: string; enabled: boolean }[];
    }>("GET", "/feature-flags");
    return new Set(
      body.flags.filter((flag) => flag.enabled).map((flag) => flag.key),
    );
  }

  /**
   * `GET /health/ready`: whether the server reports itself ready to serve. It
   * answers 503 with the failing checks when it is not, which this throws as a
   * {@link SwitchHttpError} carrying them.
   */
  async ready(): Promise<void> {
    await this.request("GET", "/health/ready", { timeoutMs: 10_000 });
  }

  /** `GET /health` — the reachability probe the suite skips on. */
  async health(): Promise<void> {
    const body = await this.request<{ status?: string }>("GET", "/health", {
      timeoutMs: 5_000,
    });
    if (body?.status !== "ok") {
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
    const { response } = await this.rawRequest("POST", "/gateway/auth/login", {
      body: { email: this.adminEmail, password: this.adminPassword },
    });
    const cookie = sessionCookieFrom(response);
    if (!cookie) {
      throw new Error(
        "Gateway login succeeded but returned no switch_auth cookie — the gateway " +
          "authenticates with a session cookie, not a bearer token.",
      );
    }
    this.issued.record(cookie.slice("switch_auth=".length));
    this.gatewayCookie = cookie;
    return cookie;
  }

  private async gateway<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.request<T>(method, `/gateway${path}`, {
      cookie: await this.gatewayLogin(),
      body,
    });
  }

  async listRooms(): Promise<RoomSummary[]> {
    const rows = await this.gateway<RawRoom[]>("GET", "/rooms");
    return rows.map(toRoomSummary);
  }

  async getRoom(roomId: string): Promise<RoomDetail> {
    return toRoomDetail(await this.gateway<RawRoom>("GET", `/rooms/${roomId}`));
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
   *
   * `bridgeId: null` makes an internal-only room: no platform channel, so the
   * only participants are agents and the fast lane needs no bridge at all.
   */
  async createRoom(params: {
    name: string;
    description: string;
    bridgeId: string | null;
    agentNames: string[];
    userNames: string[];
  }): Promise<RoomDetail> {
    const row = await this.gateway<RawRoom>("POST", "/rooms", {
      name: params.name,
      description: params.description,
      ...(params.bridgeId === null
        ? { internal_only: true }
        : {
            bridge_id: params.bridgeId,
            internal_only: false,
            channel_type: "channel_public",
          }),
      agent_names: params.agentNames,
      user_names: params.userNames,
    });
    return toRoomDetail(row);
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.gateway("DELETE", `/rooms/${roomId}`);
  }

  /**
   * `DELETE /gateway/agents/by-name/{name}` — admin-authenticated teardown that,
   * unlike `DELETE /agents/{id}`, does not need the agent's own API key. Used by
   * the cleanup script for agents left behind by an interrupted run.
   */
  async deleteAgentByName(name: string): Promise<void> {
    await this.gateway("DELETE", `/agents/by-name/${encodeURIComponent(name)}`);
  }

  /**
   * `POST /gateway/management/agents` — register an agent owned by the signed-in
   * admin and place it on a controller, which then runs its sessions. The
   * server checks the placement before registering anything, so a refusal
   * leaves nothing behind and the call can simply be repeated.
   *
   * Refused with 409 until the controller has connected and reported the
   * provider installed and signed in; see {@link managementErrorCode}.
   */
  async createManagedAgent(params: {
    name: string;
    description: string;
    controllerId: string;
    definition: ManagedAgentDefinition;
  }): Promise<AgentRef> {
    const view = await this.gateway<{ agent_id: string; name: string }>(
      "POST",
      "/management/agents",
      {
        name: params.name,
        description: params.description,
        controller_id: params.controllerId,
        desired_state: "running",
        definition: params.definition,
      },
    );
    return { id: view.agent_id, name: view.name };
  }

  /**
   * `PUT /gateway/agents/{id}/addressing-policy` with `{policy: null}` — clear
   * the agent's scoped addressing policy, so anyone may address it.
   *
   * Agents are created owner-only: only their owner, or agents and identities
   * the owner has claimed, may address them, and anything else is answered with
   * a refusal instead of delivered. The harness's senders are other throwaway
   * agents and an unclaimed platform user, so its agents are opened explicitly.
   */
  async openAddressing(agentId: string): Promise<void> {
    await this.gateway("PUT", `/agents/${agentId}/addressing-policy`, {
      policy: null,
    });
  }

  /**
   * The status Switch reports for one agent in one room. `live` means a session
   * is attending the room; `dormant` means an auto-session connector is watching
   * and would spawn one; `no_session` / `disconnected` mean nothing is there.
   */
  async agentStatusInRoom(
    roomId: string,
    agentId: string,
  ): Promise<string | null> {
    const row = await this.gateway<RawRoom>("GET", `/rooms/${roomId}`);
    const statuses = row.agent_statuses;
    if (!statuses || typeof statuses !== "object") return null;
    const status = (statuses as Record<string, unknown>)[agentId];
    return typeof status === "string" ? status : null;
  }

  /**
   * `PUT /gateway/agents/{id}/name` — rename an agent and set its display name
   * in the same step. Returns the name the server now holds.
   */
  async renameAgent(
    agentId: string,
    name: string,
    displayName: string | null,
  ): Promise<{
    name: string;
    displayName: string | null;
    bridgeFailures: string[];
  }> {
    const body = await this.gateway<{
      agent: { name: string; display_name: string | null };
      bridge_failures: string[];
    }>("PUT", `/agents/${agentId}/name`, { name, display_name: displayName });
    return {
      name: body.agent.name,
      displayName: body.agent.display_name,
      bridgeFailures: body.bridge_failures,
    };
  }

  /**
   * `POST /gateway/collaborations/{bridge}/identities` on the default bridge
   * of `bridgeType` — link a chat account to the signed-in Switch user, so
   * Switch can recognise that person in a room (what the rename and delete
   * chat commands check).
   */
  async claimIdentity(
    bridgeType: string,
    externalUserId: string,
    username: string,
  ): Promise<void> {
    const bridges = await this.gateway<
      { bridge_id: string; bridge_type: string; is_default?: boolean }[]
    >("GET", "/collaborations");
    const ofType = bridges.filter((row) => row.bridge_type === bridgeType);
    const bridge = ofType.find((row) => row.is_default) ?? ofType[0];
    if (!bridge)
      throw new Error(
        `No ${bridgeType} collaboration bridge on this Switch server`,
      );
    await this.gateway(
      "POST",
      `/collaborations/${bridge.bridge_id}/identities`,
      {
        external_user_id: externalUserId,
        username,
        user_id: null,
      },
    );
  }

  async listAgents(): Promise<AgentSummary[]> {
    const rows = await this.gateway<
      { id: string; name: string; created_at: string }[]
    >("GET", "/agents");
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    }));
  }

  /** `GET /gateway/auth/session` — the workspace this admin session is bound to. */
  async tenantId(): Promise<string> {
    const state = await this.gateway<{
      state: string;
      tenant: { id: string } | null;
    }>("GET", "/auth/session");
    if (state.tenant === null) {
      throw new Error(
        `The gateway admin's session is bound to no workspace (state '${state.state}').`,
      );
    }
    return state.tenant.id;
  }

  /**
   * `GET /gateway/tenants/{tenant_id}/usage` — what each client spent, per
   * metric and model, over `[since, until)`. Counted in whole UTC hours.
   */
  async usage(
    tenantId: string,
    since: Date,
    until: Date,
  ): Promise<UsageTotal[]> {
    const query = `since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`;
    const rows = await this.gateway<
      {
        metric: string;
        client_id: string;
        client_name: string | null;
        model: string;
        amount: number;
      }[]
    >("GET", `/tenants/${tenantId}/usage?${query}`);
    return rows.map((row) => ({
      metric: row.metric,
      clientId: row.client_id,
      clientName: row.client_name,
      model: row.model,
      amount: row.amount,
    }));
  }

  /** The bridge id of the default collaboration bridge of `type`. */
  async defaultBridgeId(type: string): Promise<string> {
    return (await this.defaultBridge(type)).id;
  }

  /** The default collaboration bridge of `type`: its id, and the display name a room document names it by. */
  async defaultBridge(
    type: string,
  ): Promise<{ id: string; displayName: string }> {
    const rows = await this.gateway<
      {
        id: string;
        bridge_type: string;
        display_name: string;
        is_default?: boolean;
      }[]
    >("GET", "/collaborations");
    const ofType = rows.filter((row) => row.bridge_type === type);
    if (ofType.length === 0) {
      throw new Error(
        `No ${type} collaboration bridge registered on this Switch server`,
      );
    }
    const row = ofType.find((candidate) => candidate.is_default) ?? ofType[0]!;
    return { id: row.id, displayName: row.display_name };
  }

  /**
   * `POST /gateway/rooms/from-yaml` — provision one room from a room document,
   * as the signed-in admin; the gateway's side of `create_room_from_yaml`.
   * Anything the room was given that could not be attached is a failure, not a
   * room that is quietly missing part of its setup.
   */
  async createRoomFromYaml(yaml: string): Promise<RoomDetail> {
    const result = await this.gateway<{
      room_id?: string;
      failed_attachments?: unknown[];
    }>("POST", "/rooms/from-yaml", { yaml });
    if (result.room_id === undefined) {
      throw new Error(
        `from-yaml did not make one room: ${JSON.stringify(result)}`,
      );
    }
    const roomId = result.room_id;
    if (
      result.failed_attachments !== undefined &&
      result.failed_attachments.length > 0
    ) {
      throw await this.withRoomDeleted(
        roomId,
        new Error(
          `from-yaml made room ${roomId} without part of what it was given: ` +
            JSON.stringify(result.failed_attachments),
        ),
      );
    }
    try {
      return await this.getRoom(roomId);
    } catch (error) {
      throw await this.withRoomDeleted(roomId, error);
    }
  }

  /** Delete a room a call made before failing, and return the failure, saying whether the room went too. */
  private async withRoomDeleted(
    roomId: string,
    failure: unknown,
  ): Promise<Error> {
    const reason = failure instanceof Error ? failure.message : String(failure);
    try {
      await this.deleteRoom(roomId);
      return new Error(`${reason} (room ${roomId} was deleted)`, {
        cause: failure,
      });
    } catch (cleanup) {
      const why = cleanup instanceof Error ? cleanup.message : String(cleanup);
      return new Error(
        `${reason} (and room ${roomId} could not be deleted, delete it by hand: ${why})`,
        {
          cause: failure,
        },
      );
    }
  }

  /**
   * Find the Switch room bound to a given external (Mattermost) channel id.
   * The room list does not carry `external_channel_id`, so each candidate room
   * on the bridge is read in full — the set is small on a dev server, and the
   * alternative (matching on display name) is ambiguous.
   */
  async findRoomByExternalChannel(
    bridgeId: string,
    externalChannelId: string,
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
    deadlineMs: number,
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
        `Is the Mattermost bridge running and is the agent's bot a member of the channel?`,
    );
  }

  // ── agent bridge: registration ────────────────────────────────────────────

  /**
   * Register a "known agent" (`POST /agents/register-known`, registration-token
   * auth). `agentType` is one of the gateway's known types — `claude-code`,
   * `codex`, `opencode`, `cursor` or `antigravity` — and `options` is that
   * type's option schema, which for OpenCode is `{ auto_session, repo_dir }`.
   *
   * Registration is also what mints the agent's Mattermost bot account: the
   * protocol service calls `create_agent_identity` on every collaboration
   * bridge, and the Mattermost adapter creates a bot whose **username is the
   * agent name verbatim**. So the agent must be registered before its bot can
   * be added to a channel.
   */
  async registerKnownAgent(params: {
    agentType: "opencode" | "codex" | "claude-code" | "antigravity" | "cursor";
    name: string;
    description: string;
    options?: Record<string, unknown>;
  }): Promise<RegisteredAgent> {
    const body = await this.request<{ id: string; api_key: string }>(
      "POST",
      "/agents/register-known",
      {
        token: this.registrationToken,
        body: {
          agent_type: params.agentType,
          name: params.name,
          description: params.description,
          options: params.options ?? {},
        },
      },
    );
    this.issued.record(body.api_key);
    return { id: body.id, name: params.name, apiKey: body.api_key };
  }

  /**
   * `DELETE /agents/{id}` authenticated as the agent itself — the registration
   * token is not accepted here, the handler compares the token's agent against
   * the path id.
   */
  async deleteAgent(agent: RegisteredAgent): Promise<void> {
    await this.request("DELETE", `/agents/${agent.id}`, {
      token: agent.apiKey,
    });
  }

  // ── agent bridge: acting as an agent ──────────────────────────────────────

  /**
   * Long-poll `GET /agents/{id}/notifications?timeout=` as the agent. Returns
   * only *notifiable* events (addressed messages and listened-for
   * joins) and never drains the per-room queues a live session polls, so the
   * harness can watch the same stream Switch Console's auto-session watcher
   * watches without stealing a running session's events.
   *
   * Returns `[]` on the server's 204 (nothing within the timeout).
   */
  async pollNotifications(
    agent: RegisteredAgent,
    timeoutSeconds = 10,
  ): Promise<AgentEvent[]> {
    const body = await this.request<{ events?: AgentEvent[] } | undefined>(
      "GET",
      `/agents/${agent.id}/notifications?timeout=${timeoutSeconds}`,
      { token: agent.apiKey, timeoutMs: (timeoutSeconds + 15) * 1000 },
    );
    return body?.events ?? [];
  }

  /** As {@link pollNotifications}, but for one room's live event queue. */
  async pollRoomEvents(
    agent: RegisteredAgent,
    roomId: string,
    timeoutSeconds = 10,
  ): Promise<AgentEvent[]> {
    const body = await this.request<{ events?: AgentEvent[] } | undefined>(
      "GET",
      `/agents/${agent.id}/rooms/${roomId}/events?timeout=${timeoutSeconds}`,
      { token: agent.apiKey, timeoutMs: (timeoutSeconds + 15) * 1000 },
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
    deadlineMs: number,
  ): Promise<{ match: AgentEvent | null; seen: AgentEvent[] }> {
    const until = Date.now() + deadlineMs;
    const seen: AgentEvent[] = [];
    while (Date.now() < until) {
      const remaining = Math.max(
        1,
        Math.min(10, Math.ceil((until - Date.now()) / 1000)),
      );
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
    limit = 20,
  ): Promise<
    {
      sender: string;
      sender_name: string;
      body: string;
      timestamp: number | null;
    }[]
  > {
    const body = await this.request<{
      events: {
        sender: string;
        sender_name: string;
        body: string;
        timestamp: number | null;
      }[];
    }>("GET", `/agents/${agent.id}/rooms/${roomId}/history?limit=${limit}`, {
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
    content: string,
  ): Promise<string> {
    const body = await this.request<{ ok: boolean; event_id: string }>(
      "POST",
      `/agents/${agent.id}/message`,
      { token: agent.apiKey, body: { room_id: roomId, content } },
    );
    return body.event_id;
  }

  // ── agent bridge: the operations front door ───────────────────────────────

  /**
   * `GET /agents/{id}/ops` — every operation the registry defines, with its
   * parameters, keyed by name. The same registry serves the MCP server, so what this lists is
   * what an agent's session sees as tools.
   */
  async listOperations(agent: RegisteredAgent): Promise<string[]> {
    const body = await this.request<{ operations: Record<string, unknown> }>(
      "GET",
      `/agents/${agent.id}/ops`,
      { token: agent.apiKey },
    );
    return Object.keys(body.operations);
  }

  /**
   * `POST /agents/{id}/ops/{operation}` — run one registry operation as the
   * agent, with `args` as its arguments, and return its `result`. Operations that act on "the room you
   * are connected to" need a live connection and fail without one; the fast
   * lane calls those that take the room as an argument.
   */
  async callOperation<T>(
    agent: RegisteredAgent,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const body = await this.request<{ result: T }>(
      "POST",
      `/agents/${agent.id}/ops/${operation}`,
      {
        token: agent.apiKey,
        body: args,
      },
    );
    return body.result;
  }

  /**
   * `POST /agents/{id}/watch/heartbeat` — the room-agnostic "an operator
   * connector is watching this agent" beat. Switch Console pings it while its
   * auto-session watcher is running; it is what makes the agent report DORMANT
   * rather than DISCONNECTED in rooms with no live session.
   */
  async watchHeartbeat(agent: RegisteredAgent): Promise<void> {
    await this.request("POST", `/agents/${agent.id}/watch/heartbeat`, {
      token: agent.apiKey,
      body: {},
    });
  }
}

interface RawRoom {
  id: string;
  name: string;
  created_at: string;
  bridge_id?: string | null;
  bridge_type?: string | null;
  archived?: boolean;
  external_channel_id?: string | null;
  matrix_room_id?: string | null;
  agent_ids?: string[];
  agent_statuses?: Record<string, unknown>;
}

function toRoomDetail(row: RawRoom): RoomDetail {
  return {
    ...toRoomSummary(row),
    externalChannelId: row.external_channel_id ?? null,
    matrixRoomId: row.matrix_room_id ?? null,
    agentIds: row.agent_ids ?? [],
  };
}

function toRoomSummary(row: RawRoom): RoomSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
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
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  for (const header of raw) {
    const pair = header.split(";", 1)[0]?.trim();
    if (pair?.startsWith("switch_auth=")) return pair;
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
