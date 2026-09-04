const BASE = "/gateway";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, credentials: "include" });
    if (!res.ok) {
      console.error(`${res.status} ${res.statusText}: ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`Fetch error: ${path}`, err);
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoomSummary {
  id: string;
  name: string;
  description: string;
  channel_type: string | null;
  admin_mode: boolean;
  agent_count: number;
  connected_user_count: number;
  connected_user_names: string[];
  bridge_id: string | null;
  bridge_display_name: string | null;
  group_id: string | null;
  group_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  created_at: string;
  archived: boolean;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  connector_type: string;
  connection_model: string | null;
  tool_count: number;
  model_count: number;
  owner_id: string | null;
  owner_name: string | null;
  oauth_client_id: string | null;
  created_at: string;
  parent_agent_id: string | null;
  known_agent_type: string | null;
  known_agent_options: Record<string, unknown> | null;
}

export interface AgentToolSummary {
  name: string;
  description: string;
}

export interface AgentModelSummary {
  name: string;
  description: string;
}

export interface AgentRoomMembership {
  room_id: string;
  room_name: string;
  archived: boolean;
  status: string;
  room_role: string | null;
}

export interface AgentSessionDetail {
  room_id: string | null;
  room_name: string | null;
  lifecycle: string;
  state: string;
  last_seen_at: string;
}

export interface AgentDetail extends AgentSummary {
  agent_type: string;
  integration_profile: Record<string, unknown>;
  tools: AgentToolSummary[];
  models: AgentModelSummary[];
  rooms: AgentRoomMembership[];
  sessions: AgentSessionDetail[];
  children: AgentSummary[];
  addressing_policy: AddressingPolicy | null;
}

// Scoped agent-addressing permissions (CHOO-1585). Each dimension is "*" (any)
// or an explicit id list ([] = none). A policy with no rules (or a null
// addressing_policy) means the agent is open to anyone. `users` ids are
// ExternalUser ids (bridged human identities); `agents` ids are agent ids.
export type AddressingDimension = "*" | string[];

export interface AddressingRule {
  rooms: AddressingDimension;
  room_groups: AddressingDimension;
  users: AddressingDimension;
  agents: AddressingDimension;
}

export interface AddressingPolicy {
  rules: AddressingRule[];
}

export interface BridgeInstallLink {
  key: string;
  label: string;
  description: string;
  url: string;
}

export interface BridgeDetail {
  bridge_id: string;
  bridge_type: string;
  display_name: string;
  status: string;
  agent_greetings_enabled: boolean;
  // Whether the platform can create channels at all. Fixed per platform —
  // not something an operator can change.
  channel_creation_supported: boolean;
  // Whether this operator has allowed this connection to create channels.
  // Only meaningful when channel_creation_supported is true.
  channel_creation_enabled: boolean;
  room_count: number;
  created_at: string;
  // Empty for platforms whose app is installed through their own admin UI.
  install_links?: BridgeInstallLink[];
  // What those links do not cover — chats that have to be joined by hand.
  install_note?: string | null;
}

export interface ExternalUserSummary {
  id: string;
  bridge_id: string;
  external_user_id: string;
  external_username: string;
}

// ── Rooms ────────────────────────────────────────────────────────────────────

export interface RoomRoleSpec {
  name: string;
  instructions: string;
  exclusive: boolean;
}

export interface RoomRoleDetail extends RoomRoleSpec {
  // Agent names currently holding the role (live lease). Empty if free; a
  // shared (non-exclusive) role may have several concurrent holders.
  held_by: string[];
}

export interface RoomDetail extends RoomSummary {
  matrix_room_id: string;
  external_channel_id: string | null;
  instructions: string | null;
  protection_config: Record<string, unknown> | null;
  observe_config: Record<string, unknown> | null;
  agent_ids: string[];
  agent_statuses: Record<string, string>;
  roles: RoomRoleDetail[];
  // Agent ids configured to receive room_join events in this room.
  join_event_listeners: string[];
  archived_at: string | null;
}

export interface CreateRoomInput {
  name: string;
  description: string;
  instructions?: string | null;
  channel_type?: string;
  agent_ids?: string[];
  agent_names?: string[];
  // Per-agent opt-in: ids (subset of agent_ids) whose subagents to also add.
  include_subagents_for?: string[];
  // Per-agent opt-in: ids (subset of agent_ids) that should receive room_join
  // events in this room.
  join_event_listeners?: string[];
  user_names?: string[];
  bridge_id?: string | null;
  external_channel_id?: string | null;
  group_id?: string | null;
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
  roles?: RoomRoleSpec[];
}

export interface UpdateRoomInput {
  name?: string;
  description?: string;
  instructions?: string | null;
  admin_mode?: boolean;
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
}

/** FastAPI's `detail` is a string for HTTPException but an array of
 * validation objects for a 422; render both as text so no error surfaces
 * as "[object Object]". */
function errorText(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : null))
      .filter((m): m is string => m !== null);
    if (msgs.length > 0) return msgs.join("; ");
  }
  return fallback;
}

async function jsonRequest<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(errorText(detail?.detail, `${res.status} ${res.statusText}`));
  }
  return (await res.json()) as T;
}

export async function fetchRooms(
  search?: string,
  includeArchived?: boolean,
): Promise<RoomSummary[] | null> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (includeArchived) params.set("include_archived", "true");
  const q = params.toString();
  return fetchJson<RoomSummary[]>(`/rooms${q ? `?${q}` : ""}`);
}

export async function fetchRoom(roomId: string): Promise<RoomDetail | null> {
  return fetchJson<RoomDetail>(`/rooms/${roomId}`);
}

export async function createRoom(input: CreateRoomInput): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>("/rooms", "POST", input);
}

export interface FailedAttachment {
  kind: string;
  id: string | null;
  error: string;
}

export interface ProvisionResult {
  room_id: string;
  room_name: string;
  attached_reference_ids: string[];
  created_reference_ids: string[];
  created_document_ids: string[];
  role_names: string[];
  failed_attachments: FailedAttachment[];
}

export interface ExportYamlToggles {
  agents?: boolean;
  users?: boolean;
  references?: boolean;
  docs?: boolean;
  roles?: boolean;
}

export async function createRoomFromYaml(
  yamlText: string,
): Promise<ProvisionResult> {
  const res = await fetch(`${BASE}/rooms/from-yaml`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-yaml" },
    body: yamlText,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ProvisionResult;
}

export async function exportRoomYaml(
  roomId: string,
  toggles: ExportYamlToggles = {},
): Promise<string> {
  const params = new URLSearchParams();
  for (const key of ["agents", "users", "references", "docs", "roles"] as const) {
    if (toggles[key] === false) params.set(key, "false");
  }
  const q = params.toString();
  const res = await fetch(
    `${BASE}/rooms/${roomId}/yaml${q ? `?${q}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.text();
}

export async function updateRoom(
  roomId: string,
  input: UpdateRoomInput,
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}`, "PATCH", input);
}

export async function fetchRoomRoles(
  roomId: string,
): Promise<RoomRoleDetail[] | null> {
  return fetchJson<RoomRoleDetail[]>(`/rooms/${roomId}/roles`);
}

export async function createRoomRole(
  roomId: string,
  input: RoomRoleSpec,
): Promise<RoomRoleDetail[]> {
  return jsonRequest<RoomRoleDetail[]>(`/rooms/${roomId}/roles`, "POST", input);
}

export async function updateRoomRole(
  roomId: string,
  name: string,
  input: { instructions?: string; exclusive?: boolean },
): Promise<RoomRoleDetail[]> {
  return jsonRequest<RoomRoleDetail[]>(
    `/rooms/${roomId}/roles/${encodeURIComponent(name)}`,
    "PATCH",
    input,
  );
}

export async function deleteRoomRole(
  roomId: string,
  name: string,
): Promise<RoomRoleDetail[]> {
  return jsonRequest<RoomRoleDetail[]>(
    `/rooms/${roomId}/roles/${encodeURIComponent(name)}`,
    "DELETE",
  );
}

export async function archiveRoom(roomId: string): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/archive`, "POST");
}

export async function unarchiveRoom(roomId: string): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/unarchive`, "POST");
}

export async function updateRoomProtection(
  roomId: string,
  config: Record<string, unknown>,
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/protection`, "PUT", {
    protection_config: config,
  });
}

export async function updateRoomObserve(
  roomId: string,
  config: Record<string, unknown>,
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/observe`, "PUT", {
    observe_config: config,
  });
}

export async function addRoomAgents(
  roomId: string,
  agentIds: string[],
  includeSubagentsFor?: string[],
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/agents`, "POST", {
    agent_ids: agentIds,
    include_subagents_for:
      includeSubagentsFor && includeSubagentsFor.length > 0
        ? includeSubagentsFor
        : undefined,
  });
}

export async function removeRoomAgent(
  roomId: string,
  agentId: string,
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/agents/${agentId}`, "DELETE");
}

export async function setRoomAgentJoinEvents(
  roomId: string,
  agentId: string,
  receivesJoinEvents: boolean,
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/agents/${agentId}`, "PATCH", {
    receives_join_events: receivesJoinEvents,
  });
}

export async function addRoomUsers(
  roomId: string,
  userNames: string[],
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/users`, "POST", {
    user_names: userNames,
  });
}

export async function deleteRoom(roomId: string): Promise<boolean> {
  const res = await fetchJson<{ ok: boolean }>(`/rooms/${roomId}`, {
    method: "DELETE",
  });
  return res?.ok ?? false;
}

export async function bulkDeleteRooms(
  roomIds: string[],
): Promise<{ deleted: number } | null> {
  return fetchJson<{ deleted: number }>("/rooms/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room_ids: roomIds }),
  });
}

export async function bulkArchiveRooms(
  roomIds: string[],
  archived: boolean,
): Promise<{ updated: number } | null> {
  return fetchJson<{ updated: number }>("/rooms/bulk-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room_ids: roomIds, archived }),
  });
}

// ── Room groups ──────────────────────────────────────────────────────────────

export interface RoomGroupDetail {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  parent_group_id: string | null;
  room_count: number;
  created_at: string;
}

export interface CreateRoomGroupInput {
  name: string;
  description?: string | null;
  color?: string | null;
  parent_group_id?: string | null;
}

// Only include `parent_group_id` when you intend to reparent: the backend keys
// off the field's presence (null = make top-level, absent = leave unchanged).
export interface UpdateRoomGroupInput {
  name?: string;
  description?: string | null;
  color?: string | null;
  parent_group_id?: string | null;
}

export async function fetchRoomGroups(): Promise<RoomGroupDetail[] | null> {
  return fetchJson<RoomGroupDetail[]>("/room-groups");
}

export async function createRoomGroup(
  input: CreateRoomGroupInput,
): Promise<RoomGroupDetail> {
  return jsonRequest<RoomGroupDetail>("/room-groups", "POST", input);
}

export async function updateRoomGroup(
  groupId: string,
  input: UpdateRoomGroupInput,
): Promise<RoomGroupDetail> {
  return jsonRequest<RoomGroupDetail>(`/room-groups/${groupId}`, "PATCH", input);
}

export async function assignRoomsToGroup(
  groupId: string,
  roomIds: string[],
): Promise<{ assigned: number }> {
  return jsonRequest<{ assigned: number }>(
    `/room-groups/${groupId}/rooms`,
    "PUT",
    { room_ids: roomIds },
  );
}

export async function deleteRoomGroup(groupId: string): Promise<void> {
  const res = await fetch(`${BASE}/room-groups/${groupId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText}`);
  }
}

export async function setRoomGroup(
  roomId: string,
  groupId: string | null,
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/group`, "PUT", {
    group_id: groupId,
  });
}

// ── Agents ───────────────────────────────────────────────────────────────────

export interface KnownAgentType {
  key: string;
  connector_type: string;
  tool_count: number;
  options_schema: Record<string, unknown>;
}

export interface RegisterResult {
  id: string;
  api_key: string;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
}

export async function fetchAgents(): Promise<AgentSummary[] | null> {
  return fetchJson<AgentSummary[]>("/agents");
}

export async function fetchAgent(agentId: string): Promise<AgentDetail | null> {
  return fetchJson<AgentDetail>(`/agents/${agentId}`);
}

export async function deleteAgent(agentId: string): Promise<boolean> {
  const res = await fetchJson<{ ok: boolean }>(`/agents/${agentId}`, {
    method: "DELETE",
  });
  return res?.ok ?? false;
}

export async function updateAgentAddressingPolicy(
  agentId: string,
  policy: AddressingPolicy | null,
): Promise<AgentDetail> {
  return jsonRequest<AgentDetail>(
    `/agents/${agentId}/addressing-policy`,
    "PUT",
    { policy },
  );
}

export async function fetchKnownAgentTypes(): Promise<KnownAgentType[] | null> {
  return fetchJson<KnownAgentType[]>("/agents/known-types");
}

export async function registerKnownAgent(
  agentType: string,
  name: string,
  description: string,
  options: Record<string, unknown> = {},
): Promise<RegisterResult> {
  const res = await fetch(`${BASE}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ agent_type: agentType, name, description, options }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return (await res.json()) as RegisterResult;
}

export async function updateAgentOptions(
  agentId: string,
  options: Record<string, unknown>,
): Promise<AgentSummary> {
  const res = await fetch(`${BASE}/agents/${agentId}/options`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ options }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail ?? `${res.status} ${res.statusText}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return (await res.json()) as AgentSummary;
}

export async function registerOtherAgent(
  name: string,
  description: string,
): Promise<RegisterResult> {
  const res = await fetch(`${BASE}/agents/register-other`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return (await res.json()) as RegisterResult;
}

// ── Connectors ──────────────────────────────────────────────────────────────

export interface ConnectorTypeConfigSchema {
  type: string;
  properties: Record<
    string,
    {
      type?: string;
      title?: string;
      description?: string;
      default?: unknown;
      format?: string;
    }
  >;
  required?: string[];
}

export interface ConnectorTypeInfo {
  key: string;
  config_schema: ConnectorTypeConfigSchema;
}

export interface ConnectorResult {
  connector_id: string;
  connector_type: string;
  display_name: string;
  status: string;
  agent_names: string[];
  created_at: string;
}

export async function fetchConnectorTypes(): Promise<ConnectorTypeInfo[] | null> {
  return fetchJson<ConnectorTypeInfo[]>("/connectors/types");
}

export async function createConnector(
  type: string,
  displayName: string,
  connectionConfig: Record<string, unknown>,
): Promise<ConnectorResult> {
  const res = await fetch(`${BASE}/connectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      type,
      display_name: displayName,
      connection_config: connectionConfig,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return (await res.json()) as ConnectorResult;
}

// ── API Keys ─────────────────────────────────────────────────────────────────

export interface ApiKeyDetail {
  id: string;
  label: string;
  type: string;
  key_prefix: string;
  created_at: string;
}

export interface CreateApiKeyResult {
  id: string;
  label: string;
  key: string;
  created_at: string;
}

export async function fetchApiKeys(): Promise<ApiKeyDetail[] | null> {
  return fetchJson<ApiKeyDetail[]>("/api-keys");
}

export async function createApiKey(label: string): Promise<CreateApiKeyResult> {
  const res = await fetch(`${BASE}/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as CreateApiKeyResult;
}

export async function revealApiKey(keyId: string): Promise<string> {
  const res = await fetch(`${BASE}/api-keys/${keyId}/reveal`, {
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { key: string };
  return data.key;
}

export async function deleteApiKey(keyId: string): Promise<boolean> {
  const res = await fetchJson<{ ok: boolean }>(`/api-keys/${keyId}`, {
    method: "DELETE",
  });
  return res?.ok ?? false;
}

// ── Collaborations ───────────────────────────────────────────────────────────

export interface BridgeTypeInfo {
  key: string;
  config_schema: ConnectorTypeConfigSchema;
  // Whether this platform can create channels at all. Fixed per platform.
  channel_creation_supported: boolean;
}

export async function fetchBridges(): Promise<BridgeDetail[] | null> {
  return fetchJson<BridgeDetail[]>("/collaborations");
}

export async function fetchBridgeTypes(): Promise<BridgeTypeInfo[] | null> {
  return fetchJson<BridgeTypeInfo[]>("/collaborations/types");
}

export async function createBridge(
  bridgeType: string,
  displayName: string,
  connectionConfig: Record<string, unknown>,
  // Defaults to true on the backend when omitted. Posting true for a platform
  // that doesn't support channel creation returns 400.
  channelCreationEnabled?: boolean,
): Promise<BridgeDetail> {
  const res = await fetch(`${BASE}/collaborations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      bridge_type: bridgeType,
      display_name: displayName,
      connection_config: connectionConfig,
      channel_creation_enabled: channelCreationEnabled,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return (await res.json()) as BridgeDetail;
}

export async function fetchBridgeUsers(
  bridgeId: string,
): Promise<ExternalUserSummary[] | null> {
  return fetchJson<ExternalUserSummary[]>(
    `/collaborations/${bridgeId}/users`,
  );
}

// Union of external (bridged human) users across every bridge. Used by the
// addressing-policy editor, whose `users` dimension keys off ExternalUser ids.
export async function fetchAllExternalUsers(): Promise<
  ExternalUserSummary[] | null
> {
  const bridges = await fetchBridges();
  if (bridges === null) return null;
  const perBridge = await Promise.all(
    bridges.map((b) => fetchBridgeUsers(b.bridge_id)),
  );
  const byId = new Map<string, ExternalUserSummary>();
  for (const users of perBridge) {
    for (const u of users ?? []) byId.set(u.id, u);
  }
  return [...byId.values()];
}

export async function deleteBridge(bridgeId: string): Promise<boolean> {
  const res = await fetchJson<{ ok: boolean }>(`/collaborations/${bridgeId}`, {
    method: "DELETE",
  });
  return res?.ok ?? false;
}

export interface BridgeUpdateInput {
  agent_greetings_enabled?: boolean;
  channel_creation_enabled?: boolean;
}

export async function updateBridge(
  bridgeId: string,
  update: BridgeUpdateInput,
): Promise<BridgeDetail | null> {
  return fetchJson<BridgeDetail>(`/collaborations/${bridgeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
}

export async function login(email: string, password: string): Promise<UserInfo> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as UserInfo;
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function fetchMe(): Promise<UserInfo | null> {
  return fetchJson<UserInfo>("/auth/me");
}

export interface AuthConfig {
  password_login_enabled: boolean;
  oidc_enabled: boolean;
  oidc_provider_label: string | null;
}

// Unauthenticated: tells the login page which methods to offer.
export async function fetchAuthConfig(): Promise<AuthConfig | null> {
  return fetchJson<AuthConfig>("/auth/config");
}

// Full-page navigation (not fetch): the IdP redirect round-trip must happen
// at the top level so cookies and the callback redirect work.
export function oidcLoginUrl(): string {
  return `${BASE}/auth/oidc/login`;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await jsonRequest("/auth/me/password", "PUT", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export async function fetchUsers(): Promise<UserInfo[] | null> {
  return fetchJson<UserInfo[]>("/users");
}

export async function createUser(
  name: string,
  email: string,
  password: string,
  role: string,
): Promise<UserInfo> {
  const res = await fetch(`${BASE}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, email, password, role }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as UserInfo;
}

// ── Resources (References & Documents) ─────────────────────────────────────

export interface ReferenceTypeInfo {
  type: string;
  display_name: string;
  instructions: string;
  value_schema: Record<string, unknown>;
  value_hint: string;
  is_builtin: boolean;
  // Null for a built-in. A user-defined type names its author wherever it is
  // offered: its instructions are prose every agent in the room is told to follow.
  owner_id: string | null;
  owner_name: string | null;
}

export interface ReferenceTypeDetail {
  type: string;
  display_name: string;
  instructions: string;
  value_schema: Record<string, unknown>;
  value_hint: string;
  is_builtin: boolean;
  owner_id: string;
  owner_name: string | null;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  shadowed_by_builtin: boolean;
  created_at: string;
}

export interface ReferenceTypeCreateInput {
  type: string;
  display_name: string;
  instructions: string;
  value_hint: string;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
}

export interface ReferenceTypeUpdateInput {
  display_name?: string;
  instructions?: string;
  value_hint?: string;
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
}

export interface ReferenceTypeDeleteResult {
  deleted_type: string;
}

export interface ReferenceDetail {
  id: string;
  owner_id: string;
  owner_name: string | null;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  type: string;
  name: string;
  description: string;
  instructions: string;
  value: Record<string, unknown>;
  attached_rooms_count: number;
  packages: string[];
  created_at: string;
  // Resolved server-side and unfiltered by the type's visibility. Null when
  // the slug resolves to no type at all.
  type_display_name: string | null;
}

export interface ReferenceCreateInput {
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  type: string;
  name: string;
  description: string;
  instructions: string;
  value: Record<string, unknown>;
}

export interface ReferenceUpdateInput {
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
  name?: string;
  description?: string;
  instructions?: string;
  value?: Record<string, unknown>;
}

export interface DocumentSummary {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  name: string;
  description: string;
  instructions: string;
  attached_rooms_count: number;
  packages: string[];
  scope: "global" | "room";
  room_id: string | null;
  created_by_agent_id: string | null;
  created_by_agent_name: string | null;
  created_at: string;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
}

export interface DocumentCreateInput {
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  name: string;
  description: string;
  instructions: string;
  content: string;
}

export interface DocumentUpdateInput {
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
  name?: string;
  description?: string;
  instructions?: string;
  content?: string;
}

export interface ResourceRoom {
  room_id: string;
  room_name: string;
}

export interface ResourceDeleteResult {
  deleted_id: string;
  detached_room_ids: string[];
  affected_package_ids?: string[];
}

export async function fetchReferenceTypes(): Promise<ReferenceTypeInfo[] | null> {
  return fetchJson<ReferenceTypeInfo[]>("/references/reference-types");
}

export async function fetchOwnedReferenceTypes(): Promise<
  ReferenceTypeDetail[] | null
> {
  return fetchJson<ReferenceTypeDetail[]>("/references/reference-types/owned");
}

export async function createReferenceType(
  input: ReferenceTypeCreateInput,
): Promise<ReferenceTypeDetail> {
  return jsonRequest<ReferenceTypeDetail>(
    "/references/reference-types",
    "POST",
    input,
  );
}

export async function updateReferenceType(
  type: string,
  input: ReferenceTypeUpdateInput,
): Promise<ReferenceTypeDetail> {
  return jsonRequest<ReferenceTypeDetail>(
    `/references/reference-types/${type}`,
    "PATCH",
    input,
  );
}

export async function deleteReferenceType(
  type: string,
): Promise<ReferenceTypeDeleteResult> {
  return jsonRequest<ReferenceTypeDeleteResult>(
    `/references/reference-types/${type}`,
    "DELETE",
  );
}

export async function fetchReferences(): Promise<ReferenceDetail[] | null> {
  return fetchJson<ReferenceDetail[]>("/references");
}

export async function fetchReference(id: string): Promise<ReferenceDetail | null> {
  return fetchJson<ReferenceDetail>(`/references/${id}`);
}

export async function createReference(
  input: ReferenceCreateInput,
): Promise<ReferenceDetail> {
  return jsonRequest<ReferenceDetail>("/references", "POST", input);
}

export async function updateReference(
  id: string,
  input: ReferenceUpdateInput,
): Promise<ReferenceDetail> {
  return jsonRequest<ReferenceDetail>(`/references/${id}`, "PATCH", input);
}

export async function deleteReference(id: string): Promise<ResourceDeleteResult> {
  return jsonRequest<ResourceDeleteResult>(`/references/${id}`, "DELETE");
}

export async function fetchReferenceRooms(id: string): Promise<ResourceRoom[] | null> {
  return fetchJson<ResourceRoom[]>(`/references/${id}/rooms`);
}

export async function fetchRoomReferences(
  roomId: string,
): Promise<ReferenceDetail[] | null> {
  return fetchJson<ReferenceDetail[]>(`/rooms/${roomId}/references`);
}

export async function attachReferenceToRoom(
  roomId: string,
  referenceId: string,
): Promise<ReferenceDetail> {
  return jsonRequest<ReferenceDetail>(
    `/rooms/${roomId}/references/${referenceId}`,
    "POST",
  );
}

export async function detachReferenceFromRoom(
  roomId: string,
  referenceId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/rooms/${roomId}/references/${referenceId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
}

// ── Linked rooms ─────────────────────────────────────────────────────────────

export interface LinkedRoomDetail {
  target_room_id: string;
  target_room_name: string;
  target_room_description: string;
  label: string;
}

export interface InboundLinkedRoomDetail {
  source_room_id: string;
  source_room_name: string;
  source_room_description: string;
  label: string;
}

export async function fetchLinkedRooms(
  roomId: string,
): Promise<LinkedRoomDetail[] | null> {
  return fetchJson<LinkedRoomDetail[]>(`/rooms/${roomId}/linked-rooms`);
}

export async function fetchInboundLinkedRooms(
  roomId: string,
): Promise<InboundLinkedRoomDetail[] | null> {
  return fetchJson<InboundLinkedRoomDetail[]>(
    `/rooms/${roomId}/linked-rooms/inbound`,
  );
}

export interface RoomGraphNode {
  id: string;
  name: string;
  description: string;
  group_id: string | null;
}

export interface RoomGraphLink {
  source_room_id: string;
  target_room_id: string;
  label: string;
}

export interface RoomGraphGroup {
  id: string;
  name: string;
  color: string | null;
  parent_group_id: string | null;
}

export interface RoomGraphData {
  rooms: RoomGraphNode[];
  links: RoomGraphLink[];
  groups: RoomGraphGroup[];
}

export async function fetchRoomGraph(): Promise<RoomGraphData | null> {
  return fetchJson<RoomGraphData>("/linked-rooms/graph");
}

// ── Ecosystem graph ──────────────────────────────────────────────────────────

export type EcosystemNodeKind = "switch" | "agent_type" | "agent" | "bridge";

export interface EcosystemNode {
  id: string;
  kind: EcosystemNodeKind;
  label: string;
  sublabel: string;
  // Present on agent nodes only when the `ecosystem.show_owners` server flag
  // is ON; otherwise omitted so the "Show owners" toggle has nothing to show.
  owner_name?: string | null;
}

export interface EcosystemEdge {
  source: string;
  target: string;
}

export interface EcosystemGraphData {
  nodes: EcosystemNode[];
  edges: EcosystemEdge[];
  // Reflects the server flag. When false, owner data is withheld.
  show_owners: boolean;
}

export async function fetchEcosystemGraph(): Promise<EcosystemGraphData | null> {
  return fetchJson<EcosystemGraphData>("/ecosystem/graph");
}

export async function attachLinkedRoom(
  roomId: string,
  targetRoomId: string,
  label: string,
): Promise<LinkedRoomDetail> {
  return jsonRequest<LinkedRoomDetail>(
    `/rooms/${roomId}/linked-rooms`,
    "POST",
    { target_room_id: targetRoomId, label },
  );
}

export async function detachLinkedRoom(
  roomId: string,
  targetRoomId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/rooms/${roomId}/linked-rooms/${targetRoomId}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
}

export async function fetchDocuments(): Promise<DocumentSummary[] | null> {
  return fetchJson<DocumentSummary[]>("/documents");
}

export async function fetchDocument(id: string): Promise<DocumentDetail | null> {
  return fetchJson<DocumentDetail>(`/documents/${id}`);
}

export async function createDocument(
  input: DocumentCreateInput,
): Promise<DocumentDetail> {
  return jsonRequest<DocumentDetail>("/documents", "POST", input);
}

export async function updateDocument(
  id: string,
  input: DocumentUpdateInput,
): Promise<DocumentDetail> {
  return jsonRequest<DocumentDetail>(`/documents/${id}`, "PATCH", input);
}

export async function deleteDocument(id: string): Promise<ResourceDeleteResult> {
  return jsonRequest<ResourceDeleteResult>(`/documents/${id}`, "DELETE");
}

export async function fetchDocumentRooms(id: string): Promise<ResourceRoom[] | null> {
  return fetchJson<ResourceRoom[]>(`/documents/${id}/rooms`);
}

export async function fetchRoomDocuments(
  roomId: string,
): Promise<DocumentSummary[] | null> {
  return fetchJson<DocumentSummary[]>(`/rooms/${roomId}/documents`);
}

export async function fetchRoomDocument(
  roomId: string,
  documentId: string,
): Promise<DocumentDetail | null> {
  return fetchJson<DocumentDetail>(`/rooms/${roomId}/documents/${documentId}`);
}

export async function attachDocumentToRoom(
  roomId: string,
  documentId: string,
): Promise<DocumentDetail> {
  return jsonRequest<DocumentDetail>(
    `/rooms/${roomId}/documents/${documentId}`,
    "POST",
  );
}

export async function detachDocumentFromRoom(
  roomId: string,
  documentId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/rooms/${roomId}/documents/${documentId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
}

// ── Packages ─────────────────────────────────────────────────────────────────

export interface PackageDetail {
  id: string;
  owner_id: string;
  owner_name: string | null;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  name: string;
  description: string;
  instructions: string;
  references_count: number;
  documents_count: number;
  attached_rooms_count: number;
  created_at: string;
}

export interface PackageCreateInput {
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  name: string;
  description: string;
  instructions: string;
}

export interface PackageUpdateInput {
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
  name?: string;
  description?: string;
  instructions?: string;
}

export interface PackageMemberRemoveResult {
  package_id: string;
  member_id: string;
  affected_room_ids: string[];
  affected_room_names: string[];
}

export async function fetchPackages(): Promise<PackageDetail[] | null> {
  return fetchJson<PackageDetail[]>("/packages");
}

export async function fetchPackage(id: string): Promise<PackageDetail | null> {
  return fetchJson<PackageDetail>(`/packages/${id}`);
}

export async function createPackage(
  input: PackageCreateInput,
): Promise<PackageDetail> {
  return jsonRequest<PackageDetail>("/packages", "POST", input);
}

export async function updatePackage(
  id: string,
  input: PackageUpdateInput,
): Promise<PackageDetail> {
  return jsonRequest<PackageDetail>(`/packages/${id}`, "PATCH", input);
}

export async function deletePackage(id: string): Promise<ResourceDeleteResult> {
  return jsonRequest<ResourceDeleteResult>(`/packages/${id}`, "DELETE");
}

export async function fetchPackageRooms(id: string): Promise<ResourceRoom[] | null> {
  return fetchJson<ResourceRoom[]>(`/packages/${id}/rooms`);
}

export async function fetchPackageReferences(
  id: string,
): Promise<ReferenceDetail[] | null> {
  return fetchJson<ReferenceDetail[]>(`/packages/${id}/references`);
}

export async function fetchPackageDocuments(
  id: string,
): Promise<DocumentSummary[] | null> {
  return fetchJson<DocumentSummary[]>(`/packages/${id}/documents`);
}

export async function addReferenceToPackage(
  packageId: string,
  referenceId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/packages/${packageId}/references/${referenceId}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
}

export async function removeReferenceFromPackage(
  packageId: string,
  referenceId: string,
): Promise<PackageMemberRemoveResult> {
  return jsonRequest<PackageMemberRemoveResult>(
    `/packages/${packageId}/references/${referenceId}`,
    "DELETE",
  );
}

export async function addDocumentToPackage(
  packageId: string,
  documentId: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/packages/${packageId}/documents/${documentId}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
}

export async function removeDocumentFromPackage(
  packageId: string,
  documentId: string,
): Promise<PackageMemberRemoveResult> {
  return jsonRequest<PackageMemberRemoveResult>(
    `/packages/${packageId}/documents/${documentId}`,
    "DELETE",
  );
}

export async function fetchRoomPackages(
  roomId: string,
): Promise<PackageDetail[] | null> {
  return fetchJson<PackageDetail[]>(`/rooms/${roomId}/packages`);
}

export async function attachPackageToRoom(
  roomId: string,
  packageId: string,
): Promise<PackageDetail> {
  return jsonRequest<PackageDetail>(
    `/rooms/${roomId}/packages/${packageId}`,
    "POST",
  );
}

export async function detachPackageFromRoom(
  roomId: string,
  packageId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/rooms/${roomId}/packages/${packageId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
}
