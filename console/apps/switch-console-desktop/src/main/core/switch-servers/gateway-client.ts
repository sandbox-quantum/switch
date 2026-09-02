import type { KnownAgentType } from '@main/core/agents/known-agent-type';
import {
  managedServerHostBlocked,
  managedServerStoppedPhase,
} from '@main/core/managed-switch-server/managed-server-status';
import { ManagedServerStoppedError } from '@shared/core/managed-switch-server/managed-switch-server';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import { policyNamesOwner } from '@shared/core/switch-servers/owner-policy';
import type {
  AddressingPolicy,
  BridgeConfigField,
  BridgeDirectoryUser,
  DeleteBridgeResult,
  LinkedIdentity,
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteBridge,
  RemoteBridgeType,
  RemoteExternalUser,
  RemoteRoomDetail,
  RemoteRoomGroup,
  RemoteRoomRole,
  RemoteRoomSummary,
  SwitchAuthConfig,
  SwitchServer,
  SwitchServerDeclaration,
  SwitchUser,
} from '@shared/core/switch-servers/switch-servers';
import { reauthenticateManagedServer, refreshSession } from './auth';
import { getSessionCookie } from './servers-store';

/** The gateway management API is mounted under `/gateway` on the server. */
function gatewayUrl(server: SwitchServer, path: string): string {
  return `${server.gatewayUrl}/gateway${path}`;
}

/** Renew the session once the stored JWT is within this window of its `exp`, so
 * an active client refreshes before the token dies rather than after a 401. */
const SESSION_REFRESH_LEEWAY_MS = 60 * 60 * 1000;

/**
 * Read the `exp` (as ms since epoch) out of a JWT without verifying it — we only
 * need the expiry to decide when to renew; the gateway still verifies the
 * signature on every call. Returns null if the token is malformed or carries no
 * numeric `exp`, in which case we skip proactive renewal and let the call fall
 * through to the normal 401 path.
 */
function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Dedupe concurrent renewals per server so a burst of authenticated calls
 * triggers at most one refresh round-trip (and one cookie write). */
const inflightRefresh = new Map<string, Promise<string | null>>();

/**
 * Given the stored JWT, return the token to attach: the same JWT if it is not
 * near expiry, otherwise a freshly renewed one (falling back to the current
 * token if renewal did not succeed — the call then 401s and the caller prompts
 * a sign-in).
 */
async function renewIfExpiring(server: SwitchServer, jwt: string): Promise<string> {
  const expMs = decodeJwtExpMs(jwt);
  if (expMs === null || expMs - Date.now() > SESSION_REFRESH_LEEWAY_MS) {
    return jwt;
  }
  let pending = inflightRefresh.get(server.id);
  if (!pending) {
    pending = refreshSession(server, jwt).finally(() => inflightRefresh.delete(server.id));
    inflightRefresh.set(server.id, pending);
  }
  const renewed = await pending;
  return renewed ?? jwt;
}

export type GatewayErrorKind = 'unauthorized' | 'http' | 'network';

/** Raised for any failed gateway call. `kind === 'unauthorized'` means the
 * stored session is missing or rejected (401) — the caller should prompt a
 * re-login rather than retrying. */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly status?: number,
    /** The gateway's own explanation, unwrapped from the FastAPI `{"detail":…}`
     * envelope. Present only when the body carried one. Prefer this over
     * `message` when showing a failure to the user: `message` is prefixed with
     * the raw status line, which reads as noise in a form. */
    readonly detail?: string
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * Unwrap FastAPI's `{"detail": "…"}` error envelope. Returns undefined for any
 * other body shape (an HTML error page, a 422 validation array, empty), leaving
 * the caller with the full status-prefixed message rather than a misleading
 * fragment.
 */
function parseErrorDetail(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    return typeof parsed.detail === 'string' ? parsed.detail : undefined;
  } catch {
    return undefined;
  }
}

type FetchOptions = {
  /** Attach the stored `switch_auth` cookie. Off for unauthenticated calls
   * such as `/auth/config`. */
  authenticated: boolean;
  method?: string;
  body?: unknown;
};

/**
 * Resolve the `switch_auth` cookie to attach to an authenticated call, renewing
 * proactively when near expiry. When no session is stored, the managed local
 * server mints one silently (Switch Console holds its admin creds); any other server
 * has no way to authenticate silently, so this raises `unauthorized`.
 */
async function resolveAuthCookie(server: SwitchServer): Promise<string> {
  const stored = await getSessionCookie(server.id);
  if (stored) {
    return renewIfExpiring(server, stored);
  }
  if (server.managed) {
    const minted = await reauthenticateManagedServer(server);
    if (minted) return minted;
  }
  throw new GatewayError('unauthorized', 'Not signed in to this Switch server.');
}

async function gatewayFetch(
  server: SwitchServer,
  path: string,
  options: FetchOptions
): Promise<Response> {
  // A remote-managed server's gateway is only reachable through the SSH forward.
  // Once the host is known unreachable the forward is dead, so a fetch can only
  // hang for its timeout and then report `Could not reach http://localhost:<port>`
  // — a local address that was never the problem. Fail with the modeled host
  // state instead, at the one point every gateway call passes through.
  const blocked = managedServerHostBlocked(server);
  if (blocked) throw new HostUnreachableError(blocked);

  // Same argument one level down: a managed stack that is stopped has no
  // gateway listening, so every call to it can only time out and report a port
  // that was never the problem — and the session renewal on the way there
  // warns about the same absence a second time. Report the lifecycle state the
  // user is already looking at instead.
  const stopped = managedServerStoppedPhase(server);
  if (stopped) throw new ManagedServerStoppedError(server, stopped);

  const sendOnce = async (cookie: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (cookie) {
      headers.Cookie = `switch_auth=${cookie}`;
    }
    try {
      return await fetch(gatewayUrl(server, path), {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        // We attach the cookie explicitly; don't let the runtime manage a jar.
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new GatewayError(
        'network',
        `Could not reach ${server.gatewayUrl}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  };

  const cookie = options.authenticated ? await resolveAuthCookie(server) : null;
  let response = await sendOnce(cookie);

  // Reactive silent re-auth for the managed local server: a 401 means the token
  // is dead (e.g. the app reopened after the stack outlived it past the TTL).
  // We hold its admin creds, so re-login and retry the call once rather than
  // bouncing the user to a sign-in screen for a password they never saw.
  if (response.status === 401 && options.authenticated && server.managed) {
    const renewed = await reauthenticateManagedServer(server);
    if (renewed) {
      response = await sendOnce(renewed);
    }
  }

  if (response.status === 401) {
    throw new GatewayError('unauthorized', 'Switch session expired — please sign in again.', 401);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new GatewayError(
      'http',
      `Switch gateway returned ${response.status}${body ? `: ${body}` : ''}`,
      response.status,
      parseErrorDetail(body)
    );
  }
  return response;
}

export async function fetchAuthConfig(server: SwitchServer): Promise<SwitchAuthConfig> {
  const res = await gatewayFetch(server, '/auth/config', { authenticated: false });
  const json = (await res.json()) as {
    password_login_enabled: boolean;
    oidc_enabled: boolean;
    oidc_provider_label: string | null;
  };
  return {
    passwordLoginEnabled: json.password_login_enabled,
    oidcEnabled: json.oidc_enabled,
    oidcProviderLabel: json.oidc_provider_label,
  };
}

type ServerDeclarationJson = {
  version: string | null;
  contracts: Record<string, { speaks: number; accepts: number }>;
};

type UserResponseJson = {
  id: string;
  name: string;
  email: string;
  role: string;
  server?: ServerDeclarationJson | null;
};

/**
 * A server declaration, or null when this server did not make one.
 *
 * Validated rather than trusted: a malformed block reads as *unknown* instead
 * of a half-populated declaration, because a version we invented is worse than
 * one we admit we do not have (CHOO-1865).
 */
function mapServerDeclaration(raw: unknown): SwitchServerDeclaration | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<ServerDeclarationJson>;
  if (typeof candidate.contracts !== 'object' || candidate.contracts === null) return null;
  const version = typeof candidate.version === 'string' ? candidate.version : null;
  return { version, contracts: candidate.contracts };
}

function mapUser(json: UserResponseJson): SwitchUser {
  return {
    id: json.id,
    name: json.name,
    email: json.email,
    role: json.role,
    server: mapServerDeclaration(json.server ?? null),
  };
}

export async function fetchMe(server: SwitchServer): Promise<SwitchUser> {
  const res = await gatewayFetch(server, '/auth/me', { authenticated: true });
  return mapUser((await res.json()) as UserResponseJson);
}

/** Options for `registerKnownAgent`, matching the gateway's
 * `RegisterKnownAgentRequest.options`. The gateway validates these against the
 * options schema of the `agent_type` being registered and ignores keys that type
 * does not declare (Codex has no channel, so it drops `channels_enabled`). */
export type RegisterKnownAgentOptions = {
  channels_enabled: boolean;
  repo_dir?: string;
  /** When true, the agent registers with the `auto_session` connection model:
   * Switch Console watches its rooms and auto-spawns a session on notification. */
  auto_session?: boolean;
};

/** The new agent's id and freshly-minted API key (the `agent` token the
 * connector authenticates with). The key is a secret — keep it in the main
 * process; never pass it to the renderer. */
export type RegisteredAgent = {
  id: string;
  apiKey: string;
};

/**
 * Register a new known agent of `agentType` on `server`, owned by the signed-in
 * user (session-authed `POST /gateway/agents/register`). Returns the new agent id
 * and its API key. A 409 (name already taken) and 400 (invalid name) surface
 * as `GatewayError` with the matching `status` so the caller can react.
 */
export async function registerKnownAgent(
  server: SwitchServer,
  params: {
    name: string;
    description: string;
    options: RegisterKnownAgentOptions;
    /** Gateway known-agent type. Required — derive it from the provider via
     * `knownAgentTypeForProvider` rather than letting a call site fall back to
     * Claude Code's shape by omission (CHOO-1436). */
    agentType: KnownAgentType;
    /** The agent's icon, or null to leave it unset and let the fallback draw
     * one. Required rather than optional so a create flow states which it
     * means instead of dropping the user's choice by forgetting the field. */
    iconUrl: string | null;
    /** The label chat platforms render the agent under, or null to leave it
     * unset and be shown under `name`. Required rather than optional for the
     * same reason as `iconUrl`: the create form holds a label the user typed,
     * and an omitted field would drop it without saying so. */
    displayName: string | null;
  }
): Promise<RegisteredAgent> {
  const res = await gatewayFetch(server, '/agents/register', {
    authenticated: true,
    method: 'POST',
    body: {
      agent_type: params.agentType,
      name: params.name,
      description: params.description,
      options: params.options,
      icon_url: params.iconUrl,
      display_name: params.displayName,
      overwrite: false,
    },
  });
  const json = (await res.json()) as { id: string; api_key: string };
  return { id: json.id, apiKey: json.api_key };
}

/** The gateway's wire shape for an agent, as `AgentSummary` and the `AgentDetail`
 * superset both send it. Fields the gateway added later are optional here so an
 * older server still parses. */
type AgentSummaryJson = {
  id: string;
  name: string;
  description: string;
  connector_type: string;
  owner_id?: string | null;
  owner_name: string | null;
  known_agent_type: string | null;
  addressing_policy?: AddressingPolicy | null;
  icon_url?: string | null;
  display_name?: string | null;
  created_at: string;
};

/** Single place the agent wire shape becomes a `RemoteAgentSummary`. Every
 * endpoint returning an agent goes through here, so a new field cannot reach
 * one caller and silently miss another. */
function toRemoteAgentSummary(json: AgentSummaryJson): RemoteAgentSummary {
  return {
    id: json.id,
    name: json.name,
    description: json.description,
    connectorType: json.connector_type,
    ownerId: json.owner_id ?? null,
    ownerName: json.owner_name,
    knownAgentType: json.known_agent_type,
    addressingPolicy: json.addressing_policy ?? null,
    iconUrl: json.icon_url ?? null,
    displayName: json.display_name ?? null,
    createdAt: json.created_at,
  };
}

export async function fetchAgents(server: SwitchServer): Promise<RemoteAgentSummary[]> {
  const res = await gatewayFetch(server, '/agents', { authenticated: true });
  const json = (await res.json()) as AgentSummaryJson[];
  return json.map(toRemoteAgentSummary);
}

/**
 * Fetch one agent's registered detail by id (`GET /agents/{id}`, which returns
 * the gateway `AgentDetail` — a superset of `AgentSummary`). Used to resolve an
 * agent's registered Switch name for display. A 404 surfaces as a `GatewayError`
 * so callers can distinguish "not on this server" from other failures.
 */
export async function fetchAgentDetail(
  server: SwitchServer,
  agentId: string
): Promise<RemoteAgentSummary> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  return toRemoteAgentSummary((await res.json()) as AgentSummaryJson);
}

/**
 * Whether `agentId` is a registered agent on `server`. Used to verify the user's
 * chosen server actually owns the agent before linking it. A 404 from the
 * gateway means "not this server" (returned as false); an unauthorized error
 * propagates so the caller can prompt a sign-in.
 */
export async function agentExistsOnServer(server: SwitchServer, agentId: string): Promise<boolean> {
  try {
    await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, { authenticated: true });
    return true;
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'http' && cause.status === 404) {
      return false;
    }
    throw cause;
  }
}

export async function fetchAgentRooms(
  server: SwitchServer,
  agentId: string
): Promise<RemoteAgentRoom[]> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as {
    rooms?: Array<{
      room_id: string;
      room_name: string;
      archived: boolean;
      status: string;
      room_role: string | null;
    }>;
  };
  return (json.rooms ?? []).map((r) => ({
    roomId: r.room_id,
    roomName: r.room_name,
    archived: r.archived,
    status: r.status,
    roomRole: r.room_role,
  }));
}

/** The agent's current known-agent options (the last validated payload) and
 * its derived connection model, from `GET /agents/{id}`. */
export type RemoteAgentOptions = {
  options: Record<string, unknown>;
  connectionModel: string | null;
};

/**
 * Fetch the agent's current known-agent options and connection model. Returns
 * empty options for agents with no known-agent type. Used to read-modify-write
 * the options payload (the PATCH endpoint is a full replace, not a merge).
 */
export async function fetchAgentOptions(
  server: SwitchServer,
  agentId: string
): Promise<RemoteAgentOptions> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as {
    known_agent_options?: Record<string, unknown> | null;
    connection_model?: string | null;
  };
  return {
    options: json.known_agent_options ?? {},
    connectionModel: json.connection_model ?? null,
  };
}

/**
 * Replace a known-agent's options (`PATCH /agents/{id}/options`). The gateway
 * re-derives the `integration_profile` from the new options, so this is the one
 * write path that keeps options and connection model in sync. The body must be
 * the FULL options payload — callers read current options first and merge.
 */
export async function updateKnownAgentOptions(
  server: SwitchServer,
  agentId: string,
  options: Record<string, unknown>
): Promise<void> {
  await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/options`, {
    authenticated: true,
    method: 'PATCH',
    body: { options },
  });
}

/**
 * Toggle the agent's `auto_session` option, preserving all other options.
 * Read-modify-writes through `updateKnownAgentOptions` so the gateway rebuilds
 * the connection model (`auto_session` ⇄ `session_addressable`).
 */
export async function setAutoSession(
  server: SwitchServer,
  agentId: string,
  enabled: boolean
): Promise<void> {
  const { options } = await fetchAgentOptions(server, agentId);
  await updateKnownAgentOptions(server, agentId, { ...options, auto_session: enabled });
}

/**
 * Fetch an agent's scoped addressing policy (CHOO-1585) from `GET /agents/{id}`.
 * Returns null when the agent is open (no policy set).
 */
export async function fetchAddressingPolicy(
  server: SwitchServer,
  agentId: string
): Promise<AddressingPolicy | null> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as {
    addressing_policy?: AddressingPolicy | null;
  };
  return json.addressing_policy ?? null;
}

/**
 * Whether the signed-in user owns an agent here whose addressing policy admits
 * its owner — the only case in which having claimed no messaging account costs
 * them anything (CHOO-2137).
 *
 * Both halves of the answer are on the agent list — `GET /agents` carries each
 * agent's `owner_id` and its policy — so this costs that list and `/auth/me`,
 * however many agents the user owns.
 *
 * A server too old to report the policy on the list leaves every agent reading
 * as open, so the warning stays quiet. That is the same answer as owning no
 * restricted agent, and the safe direction for a warning to be wrong in.
 */
export async function ownsOwnerAddressedAgent(server: SwitchServer): Promise<boolean> {
  const [me, agents] = await Promise.all([fetchMe(server), fetchAgents(server)]);
  return agents.some(
    (agent) => agent.ownerId === me.id && policyNamesOwner(agent.addressingPolicy)
  );
}

/**
 * Set (or clear, with `policy = null`) an agent's addressing policy
 * (`PUT /agents/{id}/addressing-policy`). Only the agent's owner (or an admin)
 * may change it; a non-owner request surfaces as a `GatewayError`.
 */
export async function updateAddressingPolicy(
  server: SwitchServer,
  agentId: string,
  policy: AddressingPolicy | null
): Promise<void> {
  await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/addressing-policy`, {
    authenticated: true,
    method: 'PUT',
    body: { policy },
  });
}

/**
 * Set (or clear, with `iconUrl = null`) an agent's icon (`PUT /agents/{id}/icon`).
 * Only the agent's owner (or an admin) may change it; a non-owner request
 * surfaces as a `GatewayError`, as does a URL the gateway rejects — it accepts
 * public `https` only, so a link to a private address comes back as a 400.
 *
 * Returns the agent as the gateway now holds it, so a caller can refresh from
 * the server's answer rather than assuming the value it sent was stored.
 */
export async function updateAgentIcon(
  server: SwitchServer,
  agentId: string,
  iconUrl: string | null
): Promise<RemoteAgentSummary> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}/icon`, {
    authenticated: true,
    method: 'PUT',
    body: { icon_url: iconUrl },
  });
  return toRemoteAgentSummary((await res.json()) as AgentSummaryJson);
}

/** List a server's room groups (`GET /room-groups`), for the addressing-rule
 * room-group selector. */
export async function fetchRoomGroups(server: SwitchServer): Promise<RemoteRoomGroup[]> {
  const res = await gatewayFetch(server, '/room-groups', { authenticated: true });
  const json = (await res.json()) as Array<{ id: string; name: string }>;
  return json.map((g) => ({ id: g.id, name: g.name }));
}

/** The gateway `BridgeDetail` wire shape, as returned by list, create, and
 * update. One shape and one mapper for all three, so a field cannot reach one
 * endpoint's response and miss another. */
type BridgeJson = {
  bridge_id: string;
  bridge_type: string;
  display_name: string;
  status: string;
  is_default?: boolean;
  home_url?: string | null;
  // Both absent on a server predating the capability — defaulting each to
  // true reproduces how every bridge behaved before it existed: any platform
  // could be asked to create a channel, and none had it withheld.
  channel_creation_supported?: boolean;
  channel_creation_enabled?: boolean;
  // Absent on a server predating Telegram, where every bridge had a directory.
  directory_search_supported?: boolean;
};

function mapBridge(b: BridgeJson): RemoteBridge {
  const channelCreationSupported = b.channel_creation_supported ?? true;
  const channelCreationEnabled = b.channel_creation_enabled ?? true;
  return {
    id: b.bridge_id,
    type: b.bridge_type,
    displayName: b.display_name,
    status: b.status,
    isDefault: b.is_default ?? false,
    homeUrl: b.home_url ?? null,
    channelCreationSupported,
    canCreateChannels: channelCreationSupported && channelCreationEnabled,
    directorySearchSupported: b.directory_search_supported ?? true,
  };
}

/**
 * List the collaboration bridges configured on a server (`GET /collaborations`).
 * Returns every bridge regardless of status — callers that need a usable one
 * (room creation) filter on `status === 'active'` themselves, so they can tell
 * "no bridges at all" apart from "the bridge is down".
 */
export async function fetchBridges(server: SwitchServer): Promise<RemoteBridge[]> {
  const res = await gatewayFetch(server, '/collaborations', { authenticated: true });
  const json = (await res.json()) as BridgeJson[];
  return json.map(mapBridge);
}

/** Field names that hold a credential and must be masked on input. Mirrors the
 * operator dashboard's `isSecretField`, widened to catch `*_private_key` (the
 * Teams bridge's Graph encryption key), which its bare `api_key` alternation
 * misses. */
const SECRET_FIELD_RE = /token|password|secret|api[_-]?key|private[_-]?key|credential/i;

/** JSON Schema as Pydantic's `model_json_schema()` emits it for a bridge config. */
type BridgeConfigSchemaProperty = {
  title?: string;
  description?: string;
  format?: string;
  type?: string;
  default?: unknown;
  /** Pydantic emits `bool | None` as `anyOf: [{type:"boolean"},{type:"null"}]`
   * rather than a top-level `type`, so look through it. */
  anyOf?: Array<{ type?: string }>;
};

type BridgeConfigSchema = {
  properties?: Record<string, BridgeConfigSchemaProperty>;
  required?: string[];
};

function primitiveType(prop: BridgeConfigSchemaProperty): string | undefined {
  if (prop.type) return prop.type;
  return prop.anyOf?.find((variant) => variant.type && variant.type !== 'null')?.type;
}

function humanizeFieldKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toConfigFields(schema: BridgeConfigSchema): BridgeConfigField[] {
  const required = new Set(schema.required ?? []);
  // Object key order follows the Pydantic model's field order, which puts the
  // required credentials before the optional tuning knobs — worth preserving,
  // so the form reads the way the platform's setup docs do.
  return Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const kind = primitiveType(prop) === 'boolean' ? 'boolean' : 'string';
    const fallback = kind === 'boolean' ? false : null;
    return {
      key,
      label: prop.title ?? humanizeFieldKey(key),
      description: prop.description ?? null,
      required: required.has(key),
      secret: prop.format === 'password' || SECRET_FIELD_RE.test(key),
      kind,
      default:
        typeof prop.default === 'string' || typeof prop.default === 'boolean'
          ? prop.default
          : fallback,
    };
  });
}

/**
 * The bridge types a server can register, with the credential fields each needs
 * (`GET /collaborations/types`).
 *
 * The field list is the server's to define — switch-core derives it from the
 * adapter's own config model — so the attach form is generated from this rather
 * than hard-coded per platform. A server running a newer switch-core that adds
 * a bridge type, or a field to an existing one, works without an app release.
 *
 * Fields carry their primitive type, because they are no longer all strings:
 * the Slack bridge's agent-user-groups toggle is a boolean, and the server
 * rejects an empty string as one rather than coercing it.
 */
export async function fetchBridgeTypes(server: SwitchServer): Promise<RemoteBridgeType[]> {
  const res = await gatewayFetch(server, '/collaborations/types', { authenticated: true });
  const json = (await res.json()) as Array<{
    key: string;
    config_schema: BridgeConfigSchema;
    channel_creation_supported?: boolean;
    directory_search_supported?: boolean;
  }>;
  return json.map((t) => ({
    key: t.key,
    fields: toConfigFields(t.config_schema ?? {}),
    // Absent on a server predating the capability — every platform could be
    // registered to create channels before it existed, so default true.
    channelCreationSupported: t.channel_creation_supported ?? true,
    directorySearchSupported: t.directory_search_supported ?? true,
  }));
}

/**
 * Register a collaboration bridge on `server` (admin-only
 * `POST /collaborations`), optionally making it the default for new rooms.
 *
 * The server validates the credentials against the adapter's config model,
 * mints the bridge's Matrix client, persists it and **starts the adapter
 * immediately** — there is no stack restart and no config file to write, so
 * live sessions and connected agents are unaffected.
 *
 * `connectionConfig` holds platform credentials. Do not log it, do not return
 * it to the renderer, and do not fold it into an error message: `GatewayError`
 * quotes the *response* body only, never the request.
 */
export async function createBridge(
  server: SwitchServer,
  params: {
    bridgeType: string;
    displayName: string;
    connectionConfig: Record<string, string | boolean>;
    setAsDefault: boolean;
    channelCreationEnabled: boolean;
  }
): Promise<RemoteBridge> {
  const res = await gatewayFetch(server, '/collaborations', {
    authenticated: true,
    method: 'POST',
    body: {
      bridge_type: params.bridgeType,
      display_name: params.displayName,
      connection_config: params.connectionConfig,
      set_as_default: params.setAsDefault,
      channel_creation_enabled: params.channelCreationEnabled,
    },
  });
  return mapBridge((await res.json()) as BridgeJson);
}

/**
 * Edit an existing bridge's operator-controlled switches
 * (admin-only `PATCH /collaborations/{id}`). Only fields present in `params`
 * are sent, so an unset one is left unchanged rather than reset — the gateway
 * treats the request the same way.
 *
 * Posting `channelCreationEnabled: true` for a platform whose adapter cannot
 * create channels at all returns 400 with a message naming the platform;
 * callers map that like any other rejected edit rather than a bridge-specific
 * case.
 */
export async function updateBridge(
  server: SwitchServer,
  bridgeId: string,
  params: { channelCreationEnabled?: boolean }
): Promise<RemoteBridge> {
  const res = await gatewayFetch(server, `/collaborations/${encodeURIComponent(bridgeId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: { channel_creation_enabled: params.channelCreationEnabled },
  });
  return mapBridge((await res.json()) as BridgeJson);
}

/**
 * Disconnect a collaboration bridge from `server` (admin-only
 * `DELETE /collaborations/{id}`).
 *
 * **This deletes every Switch room on the bridge before removing it**, along
 * with the conversations in them. It is the most destructive call on the
 * gateway's collaboration router, not a pause that can be undone by attaching
 * the platform again, and the caller is responsible for saying so before it is
 * made.
 *
 * Recoverable failures are mapped so the caller can name them: a non-admin gets
 * `forbidden`, and a bridge that is already gone gets `not-found` rather than a
 * success. Anything else — a rejected adapter shutdown, an unexpected 500 —
 * still throws, so a delete that did not happen can never read as one that did.
 */
export async function deleteBridge(
  server: SwitchServer,
  bridgeId: string
): Promise<DeleteBridgeResult> {
  try {
    await gatewayFetch(server, `/collaborations/${encodeURIComponent(bridgeId)}`, {
      authenticated: true,
      method: 'DELETE',
    });
    return { kind: 'deleted' };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
      if (cause.kind === 'http' && cause.status === 404) return { kind: 'not-found' };
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/** The gateway `IdentityClaimant` wire shape. */
type IdentityClaimantJson = {
  user_id: string;
  user_name: string;
};

/** The gateway `ExternalUserSummary` wire shape. */
type ExternalUserSummaryJson = {
  id: string;
  bridge_id: string;
  external_user_id: string;
  external_username: string;
  claimed_by?: IdentityClaimantJson[];
};

/**
 * Union of external (bridged human) users across every bridge on the server
 * (`GET /collaborations`, then each bridge's `/users`). The addressing policy's
 * `users` dimension keys off these ExternalUser ids.
 */
export async function fetchAllExternalUsers(server: SwitchServer): Promise<RemoteExternalUser[]> {
  const bridges = await fetchBridges(server);
  const byId = new Map<string, RemoteExternalUser>();
  for (const bridge of bridges) {
    const res = await gatewayFetch(
      server,
      `/collaborations/${encodeURIComponent(bridge.id)}/users`,
      { authenticated: true }
    );
    const users = (await res.json()) as ExternalUserSummaryJson[];
    for (const u of users) byId.set(u.id, { id: u.id, username: u.external_username });
  }
  return [...byId.values()];
}

/**
 * Search one bridge's own user directory (`GET /collaborations/{id}/directory`).
 *
 * This asks the messaging platform rather than Switch's record of who has
 * spoken, which is what lets someone claim their account in a workspace they
 * have never posted in. A platform with no searchable directory answers 501 and
 * a stopped bridge 409; both surface as a `GatewayError` the caller maps onto
 * something it can say out loud rather than an empty result list.
 */
export async function searchBridgeDirectory(
  server: SwitchServer,
  bridgeId: string,
  query: string
): Promise<{ users: BridgeDirectoryUser[]; note: string | null }> {
  const res = await gatewayFetch(
    server,
    `/collaborations/${encodeURIComponent(bridgeId)}/directory?query=${encodeURIComponent(query)}`,
    { authenticated: true }
  );
  type DirectoryUserJson = {
    external_user_id: string;
    username: string;
    display_name: string;
    email?: string | null;
    known_external_user_id?: string | null;
    claimed_by?: IdentityClaimantJson[];
  };
  // A switch-core predating the known-accounts fallback returns the bare array
  // and refuses the search outright when the platform has no directory. Both
  // shapes read the same here; the older one simply never carries a note.
  const json = (await res.json()) as
    | DirectoryUserJson[]
    | { source?: string; note?: string | null; users?: DirectoryUserJson[] };
  const rows = Array.isArray(json) ? json : (json.users ?? []);
  return {
    note: Array.isArray(json) ? null : (json.note ?? null),
    users: rows.map((u) => ({
      externalUserId: u.external_user_id,
      username: u.username,
      displayName: u.display_name,
      email: u.email ?? null,
      knownExternalUserId: u.known_external_user_id ?? null,
      claimedBy: (u.claimed_by ?? []).map((c) => ({ userId: c.user_id, userName: c.user_name })),
    })),
  };
}

/**
 * Claim a platform identity for the signed-in user
 * (`POST /collaborations/{id}/identities`). `user_id` is deliberately omitted:
 * Switch Console only ever claims on behalf of whoever is signed in, and
 * claiming for someone else is an admin action that belongs in the operator
 * dashboard. Claims are not exclusive, so an account someone else has already
 * claimed is claimed normally; a 409 means only that the bridge is stopped and
 * an unseen account cannot be provisioned, and surfaces as a `GatewayError`
 * with that status.
 */
export async function claimBridgeIdentity(
  server: SwitchServer,
  bridgeId: string,
  params: { externalUserId: string; username: string }
): Promise<ExternalUserSummaryJson> {
  const res = await gatewayFetch(
    server,
    `/collaborations/${encodeURIComponent(bridgeId)}/identities`,
    {
      authenticated: true,
      method: 'POST',
      body: { external_user_id: params.externalUserId, username: params.username },
    }
  );
  return (await res.json()) as ExternalUserSummaryJson;
}

/**
 * Drop one claim on a platform account
 * (`DELETE /collaborations/{id}/identities/{rowId}`). `externalUserRowId` is
 * the `ExternalUser` row id, not the platform's id.
 *
 * Several users can hold a claim on the same account, so `userId` says whose
 * to drop; anyone else's is left standing. Null falls back to the server's
 * default — the caller — which is what the app wants when the signed-in user's
 * id has not been read from the server yet. Releasing someone else's claim is
 * admin-only server-side.
 */
export async function releaseBridgeIdentity(
  server: SwitchServer,
  bridgeId: string,
  externalUserRowId: string,
  userId: string | null
): Promise<void> {
  const query = userId === null ? '' : `?user_id=${encodeURIComponent(userId)}`;
  await gatewayFetch(
    server,
    `/collaborations/${encodeURIComponent(bridgeId)}/identities/${encodeURIComponent(externalUserRowId)}${query}`,
    { authenticated: true, method: 'DELETE' }
  );
}

/**
 * The messaging accounts the signed-in user has claimed
 * (`GET /auth/me/identities`). An agent whose policy names its owner is
 * unreachable by that owner on any bridge missing from this list, so this is
 * what the addressing UI checks before letting a policy seal an agent off.
 */
export async function fetchMyIdentities(server: SwitchServer): Promise<LinkedIdentity[]> {
  const res = await gatewayFetch(server, '/auth/me/identities', { authenticated: true });
  const json = (await res.json()) as Array<{
    id: string;
    bridge_id: string;
    bridge_display_name: string;
    bridge_type: string;
    external_user_id: string;
    external_username: string;
  }>;
  return json.map((i) => ({
    id: i.id,
    bridgeId: i.bridge_id,
    bridgeDisplayName: i.bridge_display_name,
    bridgeType: i.bridge_type,
    externalUserId: i.external_user_id,
    externalUsername: i.external_username,
  }));
}

/** A subagent registered via the bulk endpoint. `apiKey` is a secret — keep it
 * in the main process (write it to the subagent's settings file); never pass it
 * to the renderer. */
export type BulkRegisteredSubagent = {
  agentName: string;
  name: string;
  id: string;
  apiKey: string;
};

/**
 * Register Claude Code subagents under a parent agent on `server`
 * (session-authed `POST /gateway/agents/register-known-bulk`). The signed-in
 * user must own the parent. A 409 (one or more names already exist) surfaces as
 * a `GatewayError` with status 409 so the caller can offer to overwrite.
 */
export async function registerSubagentsBulk(
  server: SwitchServer,
  params: {
    parentAgentId: string;
    subagents: { agentName: string; description: string }[];
    /** Register every subagent with the `auto_session` connection model, so a
     * watcher auto-spawns a session when the subagent is addressed. */
    autoSession: boolean;
    overwrite?: boolean;
  }
): Promise<BulkRegisteredSubagent[]> {
  const res = await gatewayFetch(server, '/agents/register-known-bulk', {
    authenticated: true,
    method: 'POST',
    body: {
      agent_type: 'claude-code',
      parent_agent_id: params.parentAgentId,
      options: params.autoSession ? { auto_session: true } : {},
      subagents: params.subagents.map((s) => ({
        subagent_name: s.agentName,
        description: s.description,
      })),
      overwrite: params.overwrite ?? false,
    },
  });
  const json = (await res.json()) as {
    results: Array<{ subagent_name: string; name: string; id: string; api_key: string }>;
  };
  return json.results.map((r) => ({
    agentName: r.subagent_name,
    name: r.name,
    id: r.id,
    apiKey: r.api_key,
  }));
}

/**
 * Delete an agent on `server` (session-authed `DELETE /agents/{agentId}`). Used
 * to deregister a subagent's child identity when it is removed from Switch Console.
 * The signed-in user must own the agent.
 */
export async function deleteAgent(server: SwitchServer, agentId: string): Promise<void> {
  await gatewayFetch(server, `/agents/${encodeURIComponent(agentId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

export async function fetchRoomRoles(
  server: SwitchServer,
  roomId: string
): Promise<RemoteRoomRole[]> {
  const res = await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}/roles`, {
    authenticated: true,
  });
  const json = (await res.json()) as Array<{
    name: string;
    instructions: string;
    exclusive: boolean;
    held_by?: string[];
  }>;
  return json.map((r) => ({
    name: r.name,
    instructions: r.instructions,
    exclusive: r.exclusive,
    heldBy: r.held_by ?? [],
  }));
}

/** The gateway `RoomSummary` wire shape. `RoomDetail` (returned by create) is a
 * superset, so the same mapper serves both. */
type RoomSummaryJson = {
  id: string;
  name: string;
  description: string;
  channel_type: string | null;
  agent_count: number;
  bridge_display_name: string | null;
  bridge_type?: string | null;
  external_channel_url?: string | null;
  owner_id?: string | null;
  archived: boolean;
  created_at: string;
};

function mapRoomSummary(r: RoomSummaryJson): RemoteRoomSummary {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    channelType: r.channel_type,
    agentCount: r.agent_count,
    bridgeDisplayName: r.bridge_display_name,
    bridgeType: r.bridge_type ?? null,
    externalChannelUrl: r.external_channel_url ?? null,
    ownerId: r.owner_id ?? null,
    archived: r.archived,
    createdAt: r.created_at,
  };
}

export async function fetchRooms(server: SwitchServer): Promise<RemoteRoomSummary[]> {
  const res = await gatewayFetch(server, '/rooms', { authenticated: true });
  const json = (await res.json()) as RoomSummaryJson[];
  return json.map(mapRoomSummary);
}

/** The gateway `RoomDetail` wire shape — `RoomSummary` plus the fields only a
 * single-room read carries. */
type RoomDetailJson = RoomSummaryJson & {
  instructions?: string | null;
  agent_ids?: string[];
  connected_user_names?: string[];
};

function mapRoomDetail(r: RoomDetailJson): RemoteRoomDetail {
  return {
    ...mapRoomSummary(r),
    instructions: r.instructions ?? null,
    agentIds: r.agent_ids ?? [],
    connectedUserNames: r.connected_user_names ?? [],
  };
}

/** One room in full (`GET /rooms/{id}`) — what its configuration page reads. */
export async function fetchRoomDetail(
  server: SwitchServer,
  roomId: string
): Promise<RemoteRoomDetail> {
  const res = await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}`, {
    authenticated: true,
  });
  return mapRoomDetail((await res.json()) as RoomDetailJson);
}

/**
 * Switch agent ids that are members of a room. One call for the whole room,
 * rather than asking every candidate agent what it belongs to. Connecting to a
 * room is only meaningful for an agent already in it, so this is what scopes the
 * agent picker when starting a session from a room.
 */
export async function fetchRoomAgentIds(server: SwitchServer, roomId: string): Promise<string[]> {
  return (await fetchRoomDetail(server, roomId)).agentIds;
}

/**
 * Change a room's own settings (`PATCH /rooms/{id}`). Requires write access to
 * the room; the gateway returns the room as it now stands, so the caller reads
 * back what was actually stored rather than assuming its own input landed.
 *
 * A field left out is left alone. An empty string is a real value and clears the
 * field — that is how a description or a set of instructions is removed.
 */
export async function updateRoom(
  server: SwitchServer,
  roomId: string,
  changes: { description?: string; instructions?: string }
): Promise<RemoteRoomDetail> {
  const res = await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}`, {
    authenticated: true,
    method: 'PATCH',
    body: changes,
  });
  return mapRoomDetail((await res.json()) as RoomDetailJson);
}

/**
 * Add agents to an existing room (`POST /rooms/{id}/agents`). Requires write
 * access to the room. Agents already in the room are ignored server-side, so
 * this is safe to call with a set that overlaps the current membership.
 */
export async function addRoomAgents(
  server: SwitchServer,
  roomId: string,
  agentIds: string[]
): Promise<void> {
  await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}/agents`, {
    authenticated: true,
    method: 'POST',
    body: { agent_ids: agentIds },
  });
}

/**
 * Remove one agent from a room (`DELETE /rooms/{id}/agents/{agentId}`). Requires
 * write access. This is membership only — the agent itself, its credentials and
 * its sessions are untouched; it simply stops being in this room.
 */
export async function removeRoomAgent(
  server: SwitchServer,
  roomId: string,
  agentId: string
): Promise<void> {
  await gatewayFetch(
    server,
    `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
    { authenticated: true, method: 'DELETE' }
  );
}

/**
 * Delete a room outright (`DELETE /rooms/{id}`), taking its history and its
 * bridged channel with it.
 *
 * The gateway decides who may: its owner, or an admin. Switch Console hides the
 * action from anyone else, but that is a courtesy — a refusal here is the
 * authoritative answer and is surfaced rather than swallowed.
 */
export async function deleteRoom(server: SwitchServer, roomId: string): Promise<void> {
  await gatewayFetch(server, `/rooms/${encodeURIComponent(roomId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

/**
 * Create a room on `server` (session-authed `POST /gateway/rooms`), owned by the
 * signed-in user. Provisioning stays entirely server-side — this is the same
 * endpoint the operator web app posts to.
 *
 * `bridgeId` is required by Switch Console even though the gateway allows an
 * unbridged room: a room with no messaging app attached is unreachable for the
 * humans it is being created for. `channel_type` is always `channel_public` for
 * now; the gateway demands the field whenever a new channel is provisioned.
 *
 * Failures throw `GatewayError` — see `createRoomOnServer` for the mapping onto
 * a user-facing result.
 */
export async function createRoom(
  server: SwitchServer,
  params: {
    name: string;
    description: string;
    instructions?: string;
    bridgeId: string;
    agentIds: string[];
  }
): Promise<RemoteRoomSummary> {
  const res = await gatewayFetch(server, '/rooms', {
    authenticated: true,
    method: 'POST',
    body: {
      name: params.name,
      description: params.description,
      instructions: params.instructions?.trim() ? params.instructions : null,
      bridge_id: params.bridgeId,
      channel_type: 'channel_public',
      agent_ids: params.agentIds,
    },
  });
  return mapRoomSummary((await res.json()) as RoomSummaryJson);
}
