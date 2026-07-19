import type {
  RemoteAgentRoom,
  RemoteAgentSummary,
  RemoteRoomRole,
  RemoteRoomSummary,
  SwitchAuthConfig,
  SwitchServer,
  SwitchUser,
} from '@shared/core/switch-servers/switch-servers';
import { getSessionCookie } from './servers-store';

/** The gateway management API is mounted under `/gateway` on the server. */
function gatewayUrl(server: SwitchServer, path: string): string {
  return `${server.gatewayUrl}/gateway${path}`;
}

export type GatewayErrorKind = 'unauthorized' | 'http' | 'network';

/** Raised for any failed gateway call. `kind === 'unauthorized'` means the
 * stored session is missing or rejected (401) — the caller should prompt a
 * re-login rather than retrying. */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

type FetchOptions = {
  /** Attach the stored `switch_auth` cookie. Off for unauthenticated calls
   * such as `/auth/config`. */
  authenticated: boolean;
  method?: string;
  body?: unknown;
};

async function gatewayFetch(
  server: SwitchServer,
  path: string,
  options: FetchOptions
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.authenticated) {
    const jwt = await getSessionCookie(server.id);
    if (!jwt) {
      throw new GatewayError('unauthorized', 'Not signed in to this Switch server.');
    }
    headers.Cookie = `switch_auth=${jwt}`;
  }

  let response: Response;
  try {
    response = await fetch(gatewayUrl(server, path), {
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

  if (response.status === 401) {
    throw new GatewayError('unauthorized', 'Switch session expired — please sign in again.', 401);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GatewayError(
      'http',
      `Switch gateway returned ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
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

type UserResponseJson = { id: string; name: string; email: string; role: string };

function mapUser(json: UserResponseJson): SwitchUser {
  return { id: json.id, name: json.name, email: json.email, role: json.role };
}

export async function fetchMe(server: SwitchServer): Promise<SwitchUser> {
  const res = await gatewayFetch(server, '/auth/me', { authenticated: true });
  return mapUser((await res.json()) as UserResponseJson);
}

/** Options for `registerKnownAgent`, matching the gateway's
 * `RegisterKnownAgentRequest.options` for the `claude-code` known-agent type. */
export type RegisterKnownAgentOptions = {
  channels_enabled: boolean;
  repo_dir?: string;
  notify_user?: string;
  /** When true, the agent registers with the `auto_session` connection model:
   * switchdash watches its rooms and auto-spawns a session on notification. */
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
 * Register a new Claude Code agent on `server`, owned by the signed-in user
 * (session-authed `POST /gateway/agents/register`). Returns the new agent id
 * and its API key. A 409 (name already taken) and 400 (invalid name) surface
 * as `GatewayError` with the matching `status` so the caller can react.
 */
export async function registerKnownAgent(
  server: SwitchServer,
  params: { name: string; description: string; options: RegisterKnownAgentOptions }
): Promise<RegisteredAgent> {
  const res = await gatewayFetch(server, '/agents/register', {
    authenticated: true,
    method: 'POST',
    body: {
      agent_type: 'claude-code',
      name: params.name,
      description: params.description,
      options: params.options,
      overwrite: false,
    },
  });
  const json = (await res.json()) as { id: string; api_key: string };
  return { id: json.id, apiKey: json.api_key };
}

export async function fetchAgents(server: SwitchServer): Promise<RemoteAgentSummary[]> {
  const res = await gatewayFetch(server, '/agents', { authenticated: true });
  const json = (await res.json()) as Array<{
    id: string;
    name: string;
    description: string;
    connector_type: string;
    owner_name: string | null;
    known_agent_type: string | null;
    created_at: string;
  }>;
  return json.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    connectorType: a.connector_type,
    ownerName: a.owner_name,
    knownAgentType: a.known_agent_type,
    createdAt: a.created_at,
  }));
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
  const json = (await res.json()) as {
    id: string;
    name: string;
    description: string;
    connector_type: string;
    owner_name: string | null;
    known_agent_type: string | null;
    created_at: string;
  };
  return {
    id: json.id,
    name: json.name,
    description: json.description,
    connectorType: json.connector_type,
    ownerName: json.owner_name,
    knownAgentType: json.known_agent_type,
    createdAt: json.created_at,
  };
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

/** A gateway child agent (e.g. a Claude Code subagent) of some parent agent. */
export type RemoteChildAgent = {
  id: string;
  /** Server-side name, e.g. `<parent-name>.<subagent-name>`. */
  name: string;
};

/**
 * The parent agent's child agents, from its `AgentDetail.children`
 * (`GET /agents/{id}`). Used to reconcile locally-discovered subagents against
 * what the gateway actually has registered. `parentName` is returned alongside
 * so callers can strip the `<parent>.<subagent>` prefix from child names.
 */
export async function fetchAgentChildren(
  server: SwitchServer,
  parentAgentId: string
): Promise<{ parentName: string; children: RemoteChildAgent[] }> {
  const res = await gatewayFetch(server, `/agents/${encodeURIComponent(parentAgentId)}`, {
    authenticated: true,
  });
  const json = (await res.json()) as {
    name: string;
    children?: Array<{ id: string; name: string }>;
  };
  return {
    parentName: json.name,
    children: (json.children ?? []).map((c) => ({ id: c.id, name: c.name })),
  };
}

/** A subagent registered via the bulk endpoint. `apiKey` is a secret — keep it
 * in the main process (write it to the subagent's settings file); never pass it
 * to the renderer. */
export type BulkRegisteredSubagent = {
  subagentName: string;
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
    subagents: { subagentName: string; description: string }[];
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
        subagent_name: s.subagentName,
        description: s.description,
      })),
      overwrite: params.overwrite ?? false,
    },
  });
  const json = (await res.json()) as {
    results: Array<{ subagent_name: string; name: string; id: string; api_key: string }>;
  };
  return json.results.map((r) => ({
    subagentName: r.subagent_name,
    name: r.name,
    id: r.id,
    apiKey: r.api_key,
  }));
}

/**
 * Delete an agent on `server` (session-authed `DELETE /agents/{agentId}`). Used
 * to deregister a subagent's child identity when it is removed from switchdash.
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

export async function fetchRooms(server: SwitchServer): Promise<RemoteRoomSummary[]> {
  const res = await gatewayFetch(server, '/rooms', { authenticated: true });
  const json = (await res.json()) as Array<{
    id: string;
    name: string;
    description: string;
    channel_type: string | null;
    agent_count: number;
    bridge_display_name: string | null;
    bridge_type?: string | null;
    external_channel_url?: string | null;
    archived: boolean;
    created_at: string;
  }>;
  return json.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    channelType: r.channel_type,
    agentCount: r.agent_count,
    bridgeDisplayName: r.bridge_display_name,
    bridgeType: r.bridge_type ?? null,
    externalChannelUrl: r.external_channel_url ?? null,
    archived: r.archived,
    createdAt: r.created_at,
  }));
}
