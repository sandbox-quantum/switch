import { type FeatureFlagState, type FeatureFlags, featureFlagsFrom } from "./featureFlags";

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
  // The viewer takes part in it: owns it, is in it (in Switch Console or
  // through a platform account they claimed), or owns an agent in it.
  viewer_is_member: boolean;
  // The viewer is one of the room's room admins: its owner, or a workspace
  // admin, made them one. Absent from servers that predate room admins.
  viewer_is_room_admin?: boolean;
  // Made in Switch Console as a chat: its people are its members, named by
  // their Switch name, rather than accounts on a messaging app. Absent from
  // servers that predate it.
  is_console_chat?: boolean;
  // What the viewer may do, as the server's room policy decides it.
  // `can_write` (owner, room admin or workspace admin) covers the room's
  // settings, roles, group and linked rooms; `can_manage` (owner or workspace
  // admin) covers its access and deleting it; `can_archive` (owner, room
  // admin or workspace admin) covers archiving it, and is absent from servers
  // that predate room admins, which read it from `can_manage`;
  // `can_manage_admins` (owner or workspace admin) covers choosing its room
  // admins. `can_attach`, `can_invite_agents` and
  // `can_add_people` (anyone in the room) cover attaching resources and
  // adding agents and people, though each agent's own "who can address me"
  // setting can still refuse a particular one;
  // `can_remove_members` (owner, room admin or workspace admin) covers taking
  // them out, and neither membership flag is set on a direct or group chat. A
  // person may also take out their own agent. `can_unlink` (owner, room admin
  // or workspace admin) covers unlinking a reference, document or package; a resource's
  // own owner may also unlink theirs while in the room. `can_transfer`
  // (managing it, and never for a chat) covers handing it to someone else.
  can_write: boolean;
  can_manage: boolean;
  can_archive?: boolean;
  can_manage_admins?: boolean;
  can_attach: boolean;
  can_invite_agents: boolean;
  can_add_people: boolean;
  can_remove_members: boolean;
  can_unlink: boolean;
  can_transfer: boolean;
}

/** Whether the viewer may archive or unarchive the room. Servers that
 * predate room admins send no `can_archive`, and archiving took managing it. */
export function canArchiveRoom(room: RoomSummary): boolean {
  return room.can_archive ?? room.can_manage;
}

export interface AgentSummary {
  id: string;
  name: string;
  // The label people read ("Notes Helper"); null when none was chosen and the
  // name is shown instead.
  display_name: string | null;
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
  // What the caller may do to the agent, as the server decides it.
  // `can_manage` (its owner or a workspace admin) covers its options, icon,
  // display name, description, who may address it, and deleting it.
  can_manage: boolean;
  // Renaming it: managing it, and neither a sub-agent nor a parent of one.
  can_rename: boolean;
  // Editing its options: managing it, and Switch Console running it from an
  // agent type it knows, which is where its options come from.
  can_edit_options: boolean;
  can_transfer: boolean;
  // Why it cannot be handed to someone else, for whoever manages it; null
  // when it can, or when they could not anyway.
  transfer_blocked_reason: string | null;
}

/** A row of the agent list: the summary, with where the agent stands now.
 * Only the list sends these. */
export interface AgentListEntry extends AgentSummary {
  // `not_tracked`: an agent that only polls, which holds nothing Switch can
  // see between polls.
  status: "online" | "offline" | "not_tracked";
  // The device a managed agent is placed on, named to its owner and to
  // workspace admins; null when it is placed on none, and for anyone else.
  device: AgentDevice | null;
}

export interface AgentDevice {
  id: string;
  name: string;
  // Whose device it is: two people's devices can share a name, as every
  // Switch Cloud device does.
  owner_name: string;
  // Removed from Switch: the agent stays placed on it, and runs nowhere,
  // until its owner moves it.
  removed: boolean;
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
  // `heartbeat` / `explicit` (a session row), `connection` (the agent's own
  // connection) or `controller` (run by the agent controller it is placed on).
  lifecycle: string;
  state: string;
  last_seen_at: string;
  // The agent controller running it, for a `controller` session; else null.
  controller_id: string | null;
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
  /**
   * Whether the agent may act on its owner's agent management: list the
   * owner's machines and managed agents, and create managed agents on them.
   * Only the owner changes it.
   */
  can_manage_agents: boolean;
  /**
   * What a message sent while the agent works does: "steer" hands it to the
   * running turn where its sender may, "queue" always waits. Absent from a
   * server that predates it.
   */
  mid_turn_delivery?: "steer" | "queue";
  // Its owner's alone: letting it manage their agents, and granting it their
  // service connections (only where the server runs them, and only to an
  // agent run from a known agent type). Seeing and removing the grants it
  // has needs only ownership.
  can_change_manage_agents: boolean;
  can_grant_services: boolean;
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
  // Symbolic subjects, resolved when a message arrives. Absent reads as
  // false, as it does server-side.
  owner?: boolean;
  owner_agents?: boolean;
  // Admit the Switch platform on its own account. Denied by default even for
  // an open policy. A platform message sent for a person is judged as that
  // person instead.
  platform?: boolean;
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
  // Why no existing channel can be linked by id on this connection, or null
  // when one can — the Switch Telegram app, whose chats come from connecting.
  channel_ids_refused?: string | null;
  // Whether a new room here can have a private channel, and whether that needs
  // the person asking to have linked their account there (Teams names them its
  // owner). Absent on an older server.
  private_channels_supported?: boolean;
  private_channel_needs_linked_account?: boolean;
  public_channel_adds_creator?: boolean;
  room_count: number;
  created_at: string;
  // Empty for platforms whose app is installed through their own admin UI.
  install_links?: BridgeInstallLink[];
  // What those links do not cover — chats that have to be joined by hand.
  install_note?: string | null;
  // Something only the platform's side can fix, found while the bridge runs —
  // an approval withdrawn, the app blocked by the organisation's admin — in
  // plain words for a banner on the connection. Null while nothing is known
  // to be wrong, or the bridge is not running.
  attention: string | null;
  // Whether the workspace chooses, here, which of the platform's teams the
  // connection's app is in (the distributed Teams app). False while the
  // bridge is not running.
  team_placement_supported: boolean;
  // What the caller may do to the connection: change it, and delete it. A
  // connection an install holds is refused at the time, with the reason.
  can_manage: boolean;
  can_delete: boolean;
  // The app new rooms use when none is named.
  is_default: boolean;
  // Opens the app's workspace in the platform itself. Null when the bridge is
  // not running or the platform has no such link.
  home_url: string | null;
  // Whether the platform delivers this app's events to an address of its
  // own, and that address. Null where Switch's configuration has no public
  // address to give it.
  receives_webhooks: boolean;
  webhook_url: string | null;
  // Whether the platform's user directory can be searched. Where it cannot
  // (Telegram), only people who have written in a connected chat can be
  // found.
  directory_search_supported: boolean;
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

/** One of a room's room admins. `name` is null when the account has no name
 * to show; `granted_by` is who made them one, null once that account is gone. */
export interface RoomAdminEntry {
  user_id: string;
  name: string | null;
  granted_by: string | null;
  granted_at: string;
}

/** A Switch user who takes part in a room. */
export interface RoomPerson {
  user_id: string;
  name: string;
}

export interface RoomDetail extends RoomSummary {
  transport_room_id: string;
  /** @deprecated Alias of `transport_room_id`, carried for the compatibility window. */
  matrix_room_id: string;
  external_channel_id: string | null;
  instructions: string | null;
  protection_config: Record<string, unknown> | null;
  observe_config: Record<string, unknown> | null;
  agent_ids: string[];
  agent_statuses: Record<string, string>;
  roles: RoomRoleDetail[];
  // Agent ids configured to receive room_join and room_leave events in this room.
  join_event_listeners: string[];
  archived_at: string | null;
  // What deleting the room can do to its platform channel, as that platform's
  // bridge declares it; null when the room has no channel.
  channel_on_delete: ChannelRetirement | null;
  /** Absent on servers that predate decision routing. */
  auto_route?: RoomAutoRoute;
  /** The room's room admins, longest-standing first. Absent on servers that
   * predate room admins. */
  room_admins?: RoomAdminEntry[];
  /** Who the viewer could make a room admin: the workspace members in the
   * room other than its owner and its room admins. Filled only when
   * `can_manage_admins`; absent on servers that predate it. */
  room_admin_candidates?: RoomPerson[];
}

/** What deleting a room does to its platform channel when asked to: archived
 * on Slack and Mattermost, deleted on Discord, left by the bot on Telegram,
 * and kept on Teams, where Switch may not remove it. */
export type ChannelRetirement = "archived" | "deleted" | "left" | "kept";

/** What deleting a room did to its platform channel. `failed` means the
 * channel is still there and someone has to remove it by hand; `reason`
 * says why. */
export interface RetireOutcome {
  outcome: ChannelRetirement | "failed";
  reason: string | null;
}

/**
 * Whether untagged messages in the room are routed by the workspace's decision
 * service (`!auto-route`), and whether they can be: `available` is false when
 * the server has the feature off or the workspace has no decision backend, and
 * `reason` then says what is missing and who can fix it.
 */
export interface RoomAutoRoute {
  on: boolean;
  available: boolean;
  reason: string | null;
  /** The id of the agent that gets undecided messages while the decision service is failing. */
  fallback_agent: string | null;
  /** That agent's name, for display. Absent on servers that predate it. */
  fallback_agent_name?: string | null;
}

export interface SetRoomAutoRouteInput {
  on?: boolean;
  fallback_agent?: string | null;
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
  // Per-agent opt-in: ids (subset of agent_ids) that should receive room_join and room_leave
  // events in this room.
  join_event_listeners?: string[];
  user_names?: string[];
  bridge_id?: string | null;
  // With no bridge_id the server uses the default bridge; this asks for a
  // room with no external channel instead.
  internal_only?: boolean;
  external_channel_id?: string | null;
  group_id?: string | null;
  // Left out, the room takes it from its channel: a private channel makes a
  // private room, anything else a public one.
  read_visibility?: "public" | "private";
  roles?: RoomRoleSpec[];
}

export interface UpdateRoomInput {
  name?: string;
  description?: string;
  instructions?: string | null;
  admin_mode?: boolean;
  read_visibility?: "public" | "private";
}

/** A failed gateway call that keeps what the server said: the status, for
 * callers that branch on it, and `detail` as sent. `message` is `detail`
 * rendered as text. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** FastAPI's `detail` is a string for HTTPException, an array of validation
 * objects for a 422, and an object for the structured errors (tenant
 * resolution's `{error, message, ...}`). Render all three as text so no error
 * surfaces as "[object Object]". */
export function errorText(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : null))
      .filter((m): m is string => m !== null);
    if (msgs.length > 0) return msgs.join("; ");
  }
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
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
    const payload = await res.json().catch(() => null);
    const detail = payload?.detail ?? null;
    throw new ApiError(
      res.status,
      detail,
      errorText(detail, `${res.status} ${res.statusText}`),
    );
  }
  return (await res.json()) as T;
}

// For a mutation whose success response carries no body (204 No Content):
// `jsonRequest` would fail calling `.json()` on it, so this skips that parse
// on success and only reads a body back on failure, where FastAPI puts one.
async function noContentRequest(path: string, method: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method, credentials: "include" });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const detail = payload?.detail ?? null;
    throw new ApiError(
      res.status,
      detail,
      errorText(detail, `${res.status} ${res.statusText}`),
    );
  }
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

/** The rooms the Rooms list opens on (archived ones left out), throwing
 * rather than answering null so a failure can say why. */
export async function loadRooms(): Promise<RoomSummary[]> {
  return jsonRequest<RoomSummary[]>("/rooms", "GET");
}

/** Every room the viewer may read, archived ones included, throwing rather
 * than answering null so a failure can say why. */
export async function loadRoomsWithArchived(): Promise<RoomSummary[]> {
  return jsonRequest<RoomSummary[]>("/rooms?include_archived=true", "GET");
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
  attached_package_ids: string[];
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

export async function fetchRoomAdmins(roomId: string): Promise<RoomAdminEntry[] | null> {
  return fetchJson<RoomAdminEntry[]>(`/rooms/${roomId}/admins`);
}

/** Make a person in the room one of its room admins. The server refuses
 * (400, with its reason) anyone who can't be one. */
export async function addRoomAdmin(roomId: string, userId: string): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(
    `/rooms/${roomId}/admins/${encodeURIComponent(userId)}`,
    "PUT",
  );
}

/** Take someone off the room's room admins, or step down as one. */
export async function removeRoomAdmin(roomId: string, userId: string): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(
    `/rooms/${roomId}/admins/${encodeURIComponent(userId)}`,
    "DELETE",
  );
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

export async function setRoomAutoRoute(
  roomId: string,
  input: SetRoomAutoRouteInput,
): Promise<RoomAutoRoute> {
  return jsonRequest<RoomAutoRoute>(`/rooms/${roomId}/auto-route`, "PUT", input);
}

export async function addRoomUsers(
  roomId: string,
  userNames: string[],
): Promise<RoomDetail> {
  return jsonRequest<RoomDetail>(`/rooms/${roomId}/users`, "POST", {
    user_names: userNames,
  });
}

/** Delete the room. Its platform channel is kept unless `retireChannel`
 * asks for what `channel_on_delete` says; `channel` reports how that went. */
export async function deleteRoom(
  roomId: string,
  retireChannel: boolean,
): Promise<{ ok: boolean; channel: RetireOutcome | null }> {
  return jsonRequest(`/rooms/${roomId}?retire_channel=${retireChannel}`, "DELETE");
}

/** Archive or unarchive many rooms. The server skips, without failing, any
 * room the viewer may not change or that is gone, and says how many it did
 * change. */
export async function bulkArchiveRooms(
  roomIds: string[],
  archived: boolean,
): Promise<{ updated: number }> {
  return jsonRequest<{ updated: number }>("/rooms/bulk-archive", "POST", {
    room_ids: roomIds,
    archived,
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

/** The agents the Agents list shows, throwing rather than answering null so
 * a failure can say why. */
export async function loadAgents(): Promise<AgentListEntry[]> {
  return jsonRequest<AgentListEntry[]>("/agents", "GET");
}

/**
 * The agents the viewer may bring in, as the server's invite rule decides: into
 * `roomId`, less those already in it, or into a new room when it is absent.
 * `agent_ids` is null when the server cannot say (one from before the route),
 * where a picker offers every agent and leaves the refusal to the invite.
 */
export async function fetchRoomAgentCandidates(
  roomId?: string,
): Promise<{ agent_ids: string[] | null }> {
  const query = roomId ? `?room_id=${encodeURIComponent(roomId)}` : "";
  const answer = await fetchJson<{ agent_ids: string[] }>(`/rooms/agent-candidates${query}`);
  return { agent_ids: answer?.agent_ids ?? null };
}

/** Of `agents`, the ones a picker may offer given the candidates: all when unknown. */
export function invitableAgents<T extends { id: string }>(
  agents: readonly T[],
  candidateIds: readonly string[] | null | undefined,
): T[] {
  if (!candidateIds) return [...agents];
  const allowed = new Set(candidateIds);
  return agents.filter((agent) => allowed.has(agent.id));
}

export async function fetchAgent(agentId: string): Promise<AgentDetail | null> {
  return fetchJson<AgentDetail>(`/agents/${agentId}`);
}

export interface DeleteAgentResult {
  ok: boolean;
  // Chat platforms whose clean-up failed. The agent is deleted regardless;
  // each platform finishes the clean-up when its bridge next starts.
  bridge_cleanup_failures: string[];
}

/** Throws `ApiError` with the server's reason when it refuses. */
export async function deleteAgent(agentId: string): Promise<DeleteAgentResult> {
  return jsonRequest<DeleteAgentResult>(`/agents/${agentId}`, "DELETE");
}

export interface RenameAgentResult {
  agent: AgentSummary;
  old_name: string;
  // Chat platforms that could not be updated yet. The rename stands; each
  // catches up when its bridge next starts.
  bridge_failures: string[];
  templates_mentioning_old_name: string[];
}

// Renames the agent and sets its display name in one step. Pass the current
// display name to keep it, and null to clear it.
export async function renameAgent(
  agentId: string,
  name: string,
  displayName: string | null,
): Promise<RenameAgentResult> {
  return jsonRequest<RenameAgentResult>(`/agents/${agentId}/name`, "PUT", {
    name,
    display_name: displayName,
  });
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

export async function updateAgentMidTurnDelivery(
  agentId: string,
  mode: "steer" | "queue",
): Promise<AgentDetail> {
  return jsonRequest<AgentDetail>(
    `/agents/${agentId}/mid-turn-delivery`,
    "PUT",
    { mid_turn_delivery: mode },
  );
}

export async function updateAgentCanManageAgents(
  agentId: string,
  enabled: boolean,
): Promise<AgentDetail> {
  return jsonRequest<AgentDetail>(
    `/agents/${agentId}/can-manage-agents`,
    "PUT",
    { enabled },
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

// ── API Keys ─────────────────────────────────────────────────────────────────

export interface ApiKeyDetail {
  id: string;
  label: string;
  type: string;
  key_prefix: string;
  created_at: string;
  /** `null` for a key that never expires. */
  expires_at: string | null;
  // Copying the key, and deleting it: never a key an agent still signs in
  // with, though one a deleted agent left behind can go.
  can_reveal: boolean;
  can_delete: boolean;
}

export interface CreateApiKeyResult {
  id: string;
  label: string;
  key: string;
  created_at: string;
  expires_at: string | null;
}

/** Days until a new key stops working, or `"never"`. The server allows 1–365. */
export type ApiKeyLifetime = number | "never";

export async function fetchApiKeys(): Promise<ApiKeyDetail[] | null> {
  return fetchJson<ApiKeyDetail[]>("/api-keys");
}

export async function createApiKey(
  label: string,
  expiresInDays: ApiKeyLifetime,
): Promise<CreateApiKeyResult> {
  const res = await fetch(`${BASE}/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ label, expires_in_days: expiresInDays }),
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

export interface BridgeConfigSchema {
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

export interface BridgeTypeInfo {
  key: string;
  // How a person names the platform ("Microsoft Teams").
  display_name: string;
  // The platform's logo as SVG markup, or null where Switch ships none. Drawn
  // as an image from a data: URL, never inlined into the page.
  icon_svg: string | null;
  config_schema: BridgeConfigSchema;
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

// Throws rather than returning false: a connection created by installing the
// Switch app is refused here with a 409 saying to disconnect the app instead,
// and a caller that only sees "it didn't work" would leave the operator
// clicking Delete at a row that will never go.
export async function deleteBridge(bridgeId: string): Promise<{ ok: boolean }> {
  return jsonRequest<{ ok: boolean }>(`/collaborations/${bridgeId}`, "DELETE");
}

export interface BridgeUpdateInput {
  agent_greetings_enabled?: boolean;
  channel_creation_enabled?: boolean;
  // Merged over the stored config, not substituted for it. Used to set the
  // distributed Teams app's default team — see `updateBridge`'s callers in
  // the Teams placements panel.
  connection_config?: Record<string, unknown>;
}

// Throws with the server's reason, so a refused switch says why rather than
// flicking back as if nothing had been asked.
export async function updateBridge(
  bridgeId: string,
  update: BridgeUpdateInput,
): Promise<BridgeDetail> {
  return jsonRequest<BridgeDetail>(`/collaborations/${bridgeId}`, "PATCH", update);
}

// ── Your chat accounts ───────────────────────────────────────────────────────
//
// Which account in each messaging app is the signed-in person. A link waits
// until the account itself confirms it, by posting a one-time code from it,
// and counts for nothing before then. Every call here throws `ApiError` with
// the server's words: they say what to do next (the app is not running, the
// account is a bot nobody can link, the code has already been used).

/** An account linked to the signed-in person, from `GET /auth/me/identities`. */
export interface LinkedIdentity {
  /** The account's row id, which the calls below take. */
  id: string;
  bridge_id: string;
  bridge_display_name: string;
  bridge_type: string;
  external_user_id: string;
  external_username: string;
  /** False for a link made before links had to be confirmed: it counts, and
   *  its owner is asked to confirm it. */
  verified: boolean;
  /** When the link started counting. */
  linked_at: string;
  /** For an older link: whether a request to confirm it is waiting for the
   *  account. It ending while the link stays means the confirmation was
   *  cancelled (a wrong number tapped, say), not the link. */
  awaiting_confirmation: boolean;
}

/** An account waiting to confirm a link to the signed-in person. It counts
 *  for nothing yet. */
export interface PendingIdentity {
  id: string;
  bridge_id: string;
  bridge_display_name: string;
  bridge_type: string;
  external_user_id: string;
  external_username: string;
  /** Who started it, when that was an admin rather than the person. */
  requested_by_name: string | null;
  /** When the last code stops working; null when none has been issued. */
  code_expires_at: string | null;
}

/** A one-time code that confirms a link when posted from the account. The
 *  server keeps no copy: asking again issues a new one and retires this. */
export interface LinkCode {
  code: string;
  expires_at: string;
  /** Its lifetime when issued, to count down on this machine's clock rather
   *  than compare `expires_at` with a clock that may be wrong. */
  expires_in_seconds: number;
  /** How to post it on this platform, in Markdown whose only markup is the
   *  command in backticks. */
  instructions: string;
  /** The message Switch sent the account with numbers to tap, the quicker way
   *  to confirm; absent from a server that sends none. */
  prompt?: LinkPrompt | null;
}

/** The direct message offering numbers to tap: tapping `number` confirms
 *  the link, the same proof as posting the code. */
export interface LinkPrompt {
  number: number;
  sent: boolean;
  /** Why no message went out, when `sent` is false. */
  unavailable_reason: string | null;
  /** Opens the message on the platform, where it can link to one. */
  link: string | null;
}

export interface IdentityClaimant {
  user_id: string;
  user_name: string;
  verified: boolean;
  can_unlink: boolean;
}

/** The account a claim was made on, with everyone recognised on it and, when
 *  the link now waits for the account, the code that confirms it. */
export interface ClaimedAccount extends ExternalUserSummary {
  claimed_by: IdentityClaimant[];
  link_request: { user_id: string; code: LinkCode | null } | null;
}

export interface DirectoryPerson {
  /** The platform's own id for the account, which a claim names. */
  external_user_id: string;
  username: string;
  display_name: string;
  email: string | null;
  /** The account's row id when Switch has seen it, else null. */
  known_external_user_id: string | null;
  claimed_by: IdentityClaimant[];
}

/** Who a search found. `known` means the platform has no directory and the
 *  answer is only the accounts Switch has seen, which `note` explains. */
export interface DirectorySearch {
  source: "directory" | "known";
  note: string | null;
  users: DirectoryPerson[];
}

/** A link made before links had to be confirmed, as an admin reviews them. */
export interface UnconfirmedLink {
  id: string;
  external_user_id: string;
  external_username: string;
  user_id: string;
  user_name: string;
}

export async function fetchMyIdentities(): Promise<LinkedIdentity[]> {
  return jsonRequest<LinkedIdentity[]>("/auth/me/identities", "GET");
}

export async function fetchMyPendingIdentities(): Promise<PendingIdentity[]> {
  return jsonRequest<PendingIdentity[]>("/auth/me/identities/pending", "GET");
}

export async function searchBridgeDirectory(
  bridgeId: string,
  query: string,
): Promise<DirectorySearch> {
  return jsonRequest<DirectorySearch>(
    `/collaborations/${bridgeId}/directory?query=${encodeURIComponent(query)}`,
    "GET",
  );
}

/** Start linking an account to the signed-in person. */
export async function claimBridgeIdentity(
  bridgeId: string,
  person: { external_user_id: string; username: string },
): Promise<ClaimedAccount> {
  return jsonRequest<ClaimedAccount>(`/collaborations/${bridgeId}/identities`, "POST", {
    external_user_id: person.external_user_id,
    username: person.username,
    expects_confirmation: true,
    // Asks Switch to message the account a number to tap as well; a server
    // that sends none ignores it and the code is the way.
    wants_prompt: true,
  });
}

/** A fresh code for the signed-in person's link to this account, and a new
 *  message to tap, replacing any issued before. */
export async function issueLinkCode(bridgeId: string, identityId: string): Promise<LinkCode> {
  return jsonRequest<LinkCode>(
    `/collaborations/${bridgeId}/identities/${identityId}/code`,
    "POST",
    { wants_prompt: true },
  );
}

/** Stop waiting for the account to confirm. Never unlinks: an older link
 *  being confirmed keeps counting. */
export async function cancelLinkRequest(bridgeId: string, identityId: string): Promise<void> {
  await jsonRequest<ClaimedAccount>(
    `/collaborations/${bridgeId}/identities/${identityId}/request`,
    "DELETE",
  );
}

/** Unlink the signed-in person from this account, and drop any link to it
 *  still waiting. Anyone else linked to it stays linked. */
export async function releaseBridgeIdentity(bridgeId: string, identityId: string): Promise<void> {
  await jsonRequest<ClaimedAccount>(
    `/collaborations/${bridgeId}/identities/${identityId}`,
    "DELETE",
  );
}

export async function fetchUnconfirmedLinks(bridgeId: string): Promise<UnconfirmedLink[]> {
  return jsonRequest<UnconfirmedLink[]>(
    `/collaborations/${bridgeId}/identities/unconfirmed`,
    "GET",
  );
}

/** Stop trusting these older links until each owner confirms theirs. Returns
 *  how many stopped counting. */
export async function requireLinkConfirmation(
  bridgeId: string,
  links: readonly UnconfirmedLink[],
): Promise<number> {
  const result = await jsonRequest<{ moved: number }>(
    `/collaborations/${bridgeId}/identities/require-confirmation`,
    "POST",
    { links: links.map((link) => ({ id: link.id, user_id: link.user_id })) },
  );
  return result.moved;
}

/** Make a team the connection's default for new channels, which also turns
 *  channel creation on. Throws `ApiError` with the server's reason — the team
 *  is not one Switch is in, the connection is restarting, Microsoft could not
 *  be asked — rather than returning null, so the dialog can say which. */
export async function setDefaultTeamsTeam(
  bridgeId: string,
  teamId: string,
): Promise<BridgeDetail> {
  return jsonRequest<BridgeDetail>(`/collaborations/${bridgeId}`, "PATCH", {
    connection_config: { team_id: teamId },
    channel_creation_enabled: true,
  });
}

// ── Teams placements ─────────────────────────────────────────────────────────
//
// Which of the organisation's teams the distributed Teams app is in. Chosen
// from the connection once a Microsoft admin has approved the app — see
// `BridgeDetail.team_placement_supported`. Every call here is refused (404)
// for a bridge that is not a running connection on that app.

export interface TeamPlacement {
  team_id: string;
  name: string;
  /** Null when the team's apps could not be read (archived, restricted). */
  has_switch: boolean | null;
  is_default: boolean;
}

export interface TeamPlacements {
  teams: TeamPlacement[];
  default_team_id: string | null;
  // Whether the app is in the organisation's catalogue yet, which adding it
  // to a team needs. `catalog_problem` says why when it is not, and the
  // package can be downloaded for a Teams admin to upload by hand.
  in_catalog: boolean;
  catalog_problem: string | null;
}

// Throws, carrying the server's own words: a 404 means this connection is not
// on the distributed app, 503 that it is not running right now, and 502 that
// Microsoft refused the call — all of them are read by the panel rather than
// collapsed into a boolean.
export async function fetchTeamPlacements(bridgeId: string): Promise<TeamPlacements> {
  return jsonRequest<TeamPlacements>(`/collaborations/${bridgeId}/teams`, "GET");
}

export async function addBridgeToTeam(bridgeId: string, teamId: string): Promise<void> {
  return noContentRequest(
    `/collaborations/${bridgeId}/teams/${encodeURIComponent(teamId)}`,
    "POST",
  );
}

export async function removeBridgeFromTeam(
  bridgeId: string,
  teamId: string,
): Promise<void> {
  return noContentRequest(
    `/collaborations/${bridgeId}/teams/${encodeURIComponent(teamId)}`,
    "DELETE",
  );
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

// The app package for a Teams admin to upload by hand, when the app is not in
// the organisation's catalogue yet. Fetched (rather than a plain link) so the
// panel can keep the admin on the page and report a failure in place, the
// same way `exportRoomYaml` does for a text download.
export async function fetchTeamsAppPackage(bridgeId: string): Promise<DownloadedFile> {
  const res = await fetch(`${BASE}/collaborations/${bridgeId}/teams-package`, {
    credentials: "include",
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(errorText(payload?.detail, `${res.status} ${res.statusText}`));
  }
  const match = res.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/);
  return { blob: await res.blob(), filename: match?.[1] ?? "switch-teams-app.zip" };
}

// ── Installed apps ───────────────────────────────────────────────────────────
//
// The other way a connection comes into being: instead of an operator
// registering their own app and pasting its credentials, they install this
// deployment's app into their workspace and the platform hands the credential
// back. Most deployments have no app of their own, so `fetchInstallablePlatforms`
// answering with an empty list is the ordinary case and not a failure.

export interface InstalledApp {
  id: string;
  platform: string;
  external_workspace_id: string;
  // What a person calls it — a chat's room, or the workspace an OAuth install
  // came from — while it still has one. Null once it has ended, and absent
  // from a server that predates it.
  name?: string | null;
  // "active", "disconnected" (ended here) or "revoked" (ended at the
  // platform). The last two are kept apart because an operator whose
  // connection stopped working needs to know which of the two it was.
  status: string;
  // The platform's own spelling of what was granted, shown verbatim.
  scopes: string;
  bridge_id: string | null;
  installed_at: string;
  ended_at: string | null;
  can_disconnect: boolean;
}

// A platform installed by claiming a chat (Telegram) rather than by OAuth, and
// what the signed-in person may do with it. Worked out by the server because
// the split — an admin connects the first chat, members the rest — depends on
// whether the organisation has a connection yet. `connected` outlives the
// chats: the connection stays until an admin deletes it.
export interface ClaimablePlatform {
  platform: string;
  connected: boolean;
  can_add_chat: boolean;
}

// The OAuth platforms, offered to a tenant admin only, as the list they have
// always been read as — with the claim-based platforms carried alongside, from
// the same response, rather than fetched a second time.
export type InstallablePlatforms = string[] & {
  claimable?: ClaimablePlatform[];
};

export async function fetchInstallablePlatforms(): Promise<InstallablePlatforms | null> {
  const res = await fetchJson<{
    platforms: string[];
    claimable?: ClaimablePlatform[];
  }>("/messaging-apps");
  return res === null
    ? null
    : Object.assign([...res.platforms], { claimable: res.claimable ?? [] });
}

export async function fetchInstalledApps(): Promise<InstalledApp[] | null> {
  const res = await fetchJson<{ installs: InstalledApp[] }>(
    "/messaging-apps/installs",
  );
  return res === null ? null : res.installs;
}

// Answers with a URL rather than redirecting, because the install has to begin
// in a top-level window on the platform's own domain — a redirect returned to
// this fetch would be followed by the fetch.
export async function beginAppInstall(platform: string): Promise<string> {
  const res = await jsonRequest<{ authorize_url: string }>(
    `/messaging-apps/${platform}/install`,
    "POST",
  );
  return res.authorize_url;
}

// A link that adds the bot to a group and connects it, and the bare code a
// channel admin posts as `/connect <code>` instead, after adding the bot by
// `bot_handle`. The link and code work once, for ten minutes.
export interface ChatClaim {
  url: string;
  code: string;
  bot_handle: string;
}

export async function beginChatClaim(platform: string): Promise<ChatClaim> {
  return jsonRequest<ChatClaim>(`/messaging-apps/${platform}/claim`, "POST");
}

// Throwing, because 502 here means the platform refused to revoke, nothing was
// destroyed, and trying again is the right next move — all of which is in the
// message and none of which survives a boolean.
export async function disconnectApp(installId: string): Promise<InstalledApp> {
  return jsonRequest<InstalledApp>(
    `/messaging-apps/installs/${installId}`,
    "DELETE",
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
}

/** A user on the operator's list. */
export interface ListedUser extends UserInfo {
  // Deleting the account: never your own, nor another operator's.
  can_delete: boolean;
}

export async function login(email: string, password: string): Promise<UserInfo> {
  return jsonRequest<UserInfo>("/auth/login", "POST", { email, password });
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

// Ends every session the account holds, this one included: a copied cookie or
// a browser left signed in elsewhere stops working at once.
export async function signOutEverywhere(): Promise<void> {
  await jsonRequest("/auth/sessions/revoke", "POST");
}

export async function fetchMe(): Promise<UserInfo | null> {
  return fetchJson<UserInfo>("/auth/me");
}

export type SignupMode = "default_tenant" | "invite_only" | "open";

export interface AuthConfig {
  password_login_enabled: boolean;
  oidc_enabled: boolean;
  oidc_provider_label: string | null;
  signup_mode: SignupMode;
}

// ── Session and workspaces ──────────────────────────────────────────────────

export type TenantRole = "admin" | "member";

export type OrganizationRole = "org_admin" | "member";

export interface TenantMembership {
  id: string;
  slug: string;
  name: string;
  role: TenantRole;
  organization_role: OrganizationRole | null;
  organization_id: string | null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  is_operator: boolean;
}

export type SessionStateName = "ready" | "needs_selection" | "needs_workspace";

export interface Session {
  user: SessionUser;
  tenant: TenantMembership | null;
  tenants: TenantMembership[];
  state: SessionStateName;
  // Whether the caller may create a new organization with its first workspace.
  can_create_workspace: boolean;
  // Whether the caller may add a workspace to the current organization.
  can_add_workspace: boolean;
  // Whether an invitation naming an e-mail is sent there by this server.
  invite_email_enabled: boolean;
}

/** The signed-in session, or null when nobody is signed in. Any other
 * failure throws: a server error is not the same answer as "signed out". */
export async function fetchSession(): Promise<Session | null> {
  try {
    return await jsonRequest<Session>("/auth/session", "GET");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** Create an organization with a first workspace of the same name, and switch
 * the session into the workspace. */
export async function createTenant(name: string): Promise<TenantMembership> {
  const created = await jsonRequest<{ workspace: TenantMembership }>(
    "/organizations",
    "POST",
    { name },
  );
  return created.workspace;
}

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  role: OrganizationRole;
}

/** The organizations of the workspaces the caller may enter. */
export async function fetchOrganizations(): Promise<OrganizationSummary[]> {
  return jsonRequest<OrganizationSummary[]>("/organizations", "GET");
}

export interface WorkspaceCounts {
  id: string;
  users: number;
  agents: number;
}

/** How many people and agents each workspace the caller may enter has. */
export async function fetchWorkspaceCounts(): Promise<WorkspaceCounts[]> {
  return jsonRequest<WorkspaceCounts[]>("/tenants/counts", "GET");
}

export async function switchTenant(tenantId: string): Promise<void> {
  await jsonRequest(`/tenants/${encodeURIComponent(tenantId)}/switch`, "POST");
}

export interface Member {
  user_id: string;
  name: string;
  email: string;
  role: TenantRole;
  created_at: string;
  organization_role: OrganizationRole | null;
  // An organization admin with no membership of their own here, listed
  // because the organization makes them an admin of every workspace.
  via_organization: boolean;
  // What you may do with this member, as the server decides it: change their
  // role or remove them (an admin, never on your own row or an organization
  // admin's), and hand them something you own.
  can_change_role: boolean;
  can_remove: boolean;
  can_receive_transfer: boolean;
}

export async function fetchMembers(tenantId: string): Promise<Member[]> {
  return jsonRequest<Member[]>(`/tenants/${encodeURIComponent(tenantId)}/members`, "GET");
}

// Owner only, and only once the workspace is empty: the server refuses
// otherwise, listing what is left.
export async function deleteWorkspace(tenantId: string, name: string): Promise<void> {
  await jsonRequest(`/tenants/${encodeURIComponent(tenantId)}`, "DELETE", { name });
}

/** The longest name the server takes for a workspace. */
export const WORKSPACE_NAME_MAX = 255;

/** Rename the bound workspace. The server trims the name and answers with
 * it as stored. */
export async function renameWorkspace(
  tenantId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return jsonRequest(`/tenants/${encodeURIComponent(tenantId)}`, "PATCH", { name });
}

export type OwnershipKind =
  | "agent"
  | "room"
  | "package"
  | "reference"
  | "reference_type"
  | "document"
  | "template";

export interface OwnershipTransferResult {
  kind: OwnershipKind;
  id: string;
  owner_id: string;
  // An agent's API key is re-issued to its new owner, who has to reconnect it.
  agent_key_reissued: boolean;
}

// The current owner or a workspace admin, to a current member of the workspace.
export async function transferOwnership(
  kind: OwnershipKind,
  id: string,
  newOwnerId: string,
): Promise<OwnershipTransferResult> {
  return jsonRequest<OwnershipTransferResult>("/ownership/transfer", "POST", {
    kind,
    id,
    new_owner_id: newOwnerId,
  });
}

export async function updateMemberRole(
  tenantId: string,
  userId: string,
  role: TenantRole,
): Promise<Member> {
  return jsonRequest<Member>(
    `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
    "PATCH",
    { role },
  );
}

/** Who receives what a removed member owns in the workspace: the admin
 * removing them when that admin is a member, otherwise its longest-standing
 * other admin. */
export interface RemovalHeir {
  user_id: string;
  name: string;
  email: string;
}

export interface MemberRemovalPreview {
  /** Null when the workspace has no other admin: what they own stays theirs. */
  handed_over_to: RemovalHeir | null;
}

export interface MemberRemovalResult {
  ok: true;
  /** Sign-ins Switch could not revoke at a vendor. */
  warning: string | null;
  handed_over_to: RemovalHeir | null;
  /** How many of each kind passed to `handed_over_to`; kinds with none are absent. */
  handed_over: Partial<Record<Exclude<OwnershipKind, "agent">, number>>;
}

export async function previewMemberRemoval(
  tenantId: string,
  userId: string,
): Promise<MemberRemovalPreview> {
  return jsonRequest<MemberRemovalPreview>(
    `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}/removal`,
    "GET",
  );
}

export async function removeMember(
  tenantId: string,
  userId: string,
): Promise<MemberRemovalResult> {
  return jsonRequest<MemberRemovalResult>(
    `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
    "DELETE",
  );
}

export interface OrganizationMember {
  user_id: string;
  name: string;
  email: string;
  role: OrganizationRole;
  created_at: string;
  /** After a demotion: sign-ins Switch could not revoke at a vendor while
   * taking away what they held in workspaces they were in only as an
   * organization admin. */
  warning: string | null;
  /** What you may do with them, as the server decides it: never on your own
   * row; making them Org Admin not where the members come from account
   * settings Switch cannot change; removing them as an Org Admin only. */
  can_change_role: boolean;
  can_grant_org_admin: boolean;
  can_remove: boolean;
}

export interface OrganizationAuditEvent {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  // Read from the account, so a removed member or the platform operator is
  // named too; null only once the account is gone.
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  target_name: string | null;
  details: Record<string, unknown> | null;
}

export interface CurrentOrganization {
  id: string;
  slug: string;
  name: string;
  // Null for the platform operator there through operator access alone.
  role: OrganizationRole | null;
  // Its members, and who is its Org Admin, come from a directory kept outside
  // Switch: people are added and made Org Admin there, not here.
  members_from_directory: boolean;
  // Changes made here to those members are made in that directory too, so
  // they last; the admin may first be sent to sign in there.
  directory_takes_changes: boolean;
  // Whether the caller is one of its admins, and whether they may manage its
  // members and read what needs their attention: its admins, or the
  // operator while it has none.
  administers: boolean;
  can_manage_members: boolean;
}

export interface OperatorWorkspace {
  id: string;
  slug: string;
  name: string;
  organization_id: string | null;
  organization_name: string | null;
}

export async function fetchCurrentOrganization(): Promise<CurrentOrganization> {
  return jsonRequest<CurrentOrganization>("/organizations/current", "GET");
}

export async function fetchOrganizationWorkspaces(): Promise<TenantMembership[]> {
  return jsonRequest<TenantMembership[]>("/organizations/current/workspaces", "GET");
}

/** Add a workspace to the current organization. The session stays where it is. */
export async function createOrganizationWorkspace(name: string): Promise<TenantMembership> {
  return jsonRequest<TenantMembership>("/organizations/current/workspaces", "POST", { name });
}

/** What an organization set for a service across its workspaces: on or off,
 * and whether workspace admins may change it. */
export interface OrganizationServiceSetting {
  enabled: boolean;
  locked: boolean;
}

/** A catalog service as its organization's admins see it. */
export interface OrganizationService {
  slug: string;
  name: string;
  category: string;
  description: string;
  /** Null: the organization has no say, and each workspace decides. */
  setting: OrganizationServiceSetting | null;
  updated_by_name: string | null;
  updated_at: string | null;
  /** Why the server switched it off everywhere, whatever any workspace says; null if it didn't. */
  server_switched_off: string | null;
  /** In how many of the organization's workspaces it is on now. */
  workspaces_on: number;
  /** Workspaces whose admin set it themselves: an unlocked setting doesn't reach them. */
  workspaces_set_own: number;
  /** People across the organization's workspaces with it connected, each once. */
  connected_members: number;
}

export interface OrganizationServices {
  /** How many workspaces the organization has. */
  workspaces: number;
  services: OrganizationService[];
}

export async function fetchOrganizationServices(): Promise<OrganizationServices> {
  return jsonRequest<OrganizationServices>("/organizations/current/services", "GET");
}

/** Set a service for every workspace; `warning` says what could not be revoked yet. */
export async function setOrganizationService(
  service: string,
  setting: OrganizationServiceSetting,
): Promise<{ warning: string | null }> {
  return jsonRequest(`/organizations/current/services/${service}`, "PUT", setting);
}

/** Give up the organization's say in a service. */
export async function clearOrganizationService(
  service: string,
): Promise<{ warning: string | null }> {
  return jsonRequest(`/organizations/current/services/${service}`, "DELETE");
}

export async function fetchOrganizationMembers(): Promise<OrganizationMember[]> {
  return jsonRequest<OrganizationMember[]>("/organizations/current/members", "GET");
}

export async function updateOrganizationRole(
  userId: string,
  role: OrganizationRole,
): Promise<OrganizationMember> {
  return jsonRequest<OrganizationMember>(
    `/organizations/current/members/${encodeURIComponent(userId)}`,
    "PATCH",
    { role },
  );
}

/** The warning names sign-ins that could not be revoked at a vendor, if any. */
export async function removeOrganizationMember(
  userId: string,
): Promise<{ warning: string | null }> {
  return jsonRequest<{ warning: string | null }>(
    `/organizations/current/members/${encodeURIComponent(userId)}`,
    "DELETE",
  );
}

// Mirrors `OrganizationIssueKind` in core/switch_core/db/audit.py, by hand.
export type OrganizationIssueKind =
  | "no_org_admin"
  | "workspace_without_admin"
  | "agents_without_acting_owner"
  | "directory_organization_deleted";

/** Something in the organization that needs an admin's attention now. Read
 * from how things stand, so it is gone once fixed. */
export interface OrganizationIssue {
  kind: OrganizationIssueKind;
  // Null for an issue of the organization's own.
  workspace_id: string | null;
  workspace_name: string | null;
  agents: string[];
}

/** Its admins only, and the platform operator while it has none. */
export async function fetchOrganizationIssues(): Promise<OrganizationIssue[]> {
  return jsonRequest<OrganizationIssue[]>("/organizations/current/issues", "GET");
}

export const ORGANIZATION_AUDIT_PAGE = 50;

/** One page of the organization's audit log, newest first: the most recent
 * events, or those before `before` (an `occurred_at` from an earlier page). */
export async function fetchOrganizationAuditEvents(
  before: string | null,
): Promise<OrganizationAuditEvent[]> {
  const query = new URLSearchParams({ limit: String(ORGANIZATION_AUDIT_PAGE) });
  if (before !== null) query.set("before", before);
  return jsonRequest<OrganizationAuditEvent[]>(
    `/organizations/current/audit-events?${query}`,
    "GET",
  );
}

/** Every workspace on the server; the platform operator only. */
export async function fetchOperatorWorkspaces(): Promise<OperatorWorkspace[]> {
  return jsonRequest<OperatorWorkspace[]>("/operator/workspaces", "GET");
}

export interface Invitation {
  id: string;
  role: TenantRole;
  email: string | null;
  expires_at: string;
  uses_remaining: number;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

export type EmailDelivery = "sent" | "not_configured" | "failed" | "not_requested";

export interface CreatedInvitation extends Invitation {
  // The plaintext token, returned once, at creation, and never again.
  token: string;
  email_delivery: EmailDelivery;
}

export interface CreateInvitationInput {
  role: TenantRole;
  email: string | null;
  expires_in_hours: number;
  uses_remaining: number;
}

// ── Data retention ─────────────────────────────────────────────────────────

export const MAX_MESSAGE_RETENTION_DAYS = 3650;

export interface RetentionPolicy {
  // Null means messages are kept forever.
  message_retention_days: number | null;
  updated_at: string | null;
  updated_by_user_id: string | null;
}

export interface RetentionPreview {
  message_retention_days: number;
  messages_to_delete: number;
}

export async function fetchRetentionPolicy(tenantId: string): Promise<RetentionPolicy> {
  return jsonRequest<RetentionPolicy>(
    `/tenants/${encodeURIComponent(tenantId)}/retention`,
    "GET",
  );
}

export async function previewRetentionPolicy(
  tenantId: string,
  days: number,
): Promise<RetentionPreview> {
  return jsonRequest<RetentionPreview>(
    `/tenants/${encodeURIComponent(tenantId)}/retention/preview?days=${days}`,
    "GET",
  );
}

export async function setRetentionPolicy(
  tenantId: string,
  days: number,
): Promise<RetentionPolicy> {
  return jsonRequest<RetentionPolicy>(
    `/tenants/${encodeURIComponent(tenantId)}/retention`,
    "PUT",
    { message_retention_days: days },
  );
}

export async function clearRetentionPolicy(tenantId: string): Promise<RetentionPolicy> {
  return jsonRequest<RetentionPolicy>(
    `/tenants/${encodeURIComponent(tenantId)}/retention`,
    "DELETE",
  );
}

// ── Public rooms on private channels ──────────────────────────────────────

/** Why a listed room starts unticked. */
export type PrivateChannelRoomCaution =
  | "members_not_listed"
  | "channel_type_not_recorded"
  | "channel_type_unknown"
  | "many_people"
  | "bridge_not_connected";

export interface PrivateChannelRoom {
  room_id: string;
  name: string;
  bridge_id: string;
  bridge_name: string | null;
  bridge_type: string | null;
  // The recorded type; null when none was recorded.
  channel_type: string | null;
  people: number;
  // Null when the room's messaging app is not running.
  members_listed: boolean | null;
  cautions: PrivateChannelRoomCaution[];
  recommended: boolean;
}

export interface MakeRoomsPrivateResult {
  changed: string[];
  skipped: { room_id: string; reason: string }[];
}

export interface AskPlatformResult {
  answered: { room_id: string; channel_type: string }[];
  unanswered: { room_id: string; reason: "bridge_not_connected" | "could_not_tell" }[];
  // Set when the batch stopped early.
  stopped: "rate_limited" | "timed_out" | null;
  // Listed rooms still to ask about: no recorded type, not already found
  // unplaceable.
  remaining: number;
}

/** The most rooms one apply changes. */
export const MAKE_PRIVATE_MAX = 200;

/** How many rooms the review page would list. One query; no platform. */
export async function countPrivateChannelRooms(tenantId: string): Promise<number> {
  const result = await jsonRequest<{ count: number }>(
    `/tenants/${encodeURIComponent(tenantId)}/private-channel-rooms/count`,
    "GET",
  );
  return result.count;
}

/** Ask the messaging apps about a batch of rooms of unrecorded type; the
 * answers are saved on the rooms. */
export async function askPlatformAboutRooms(tenantId: string): Promise<AskPlatformResult> {
  return jsonRequest<AskPlatformResult>(
    `/tenants/${encodeURIComponent(tenantId)}/private-channel-rooms/ask-platform`,
    "POST",
    {},
  );
}

/** The Public rooms bound to a private channel, a group, a DM or a channel
 * of unrecorded type. A dry run: changes nothing, calls no platform. */
export async function previewPrivateChannelRooms(
  tenantId: string,
): Promise<PrivateChannelRoom[]> {
  const result = await jsonRequest<{ rooms: PrivateChannelRoom[] }>(
    `/tenants/${encodeURIComponent(tenantId)}/private-channel-rooms`,
    "GET",
  );
  return result.rooms;
}

export async function makeRoomsPrivate(
  tenantId: string,
  roomIds: string[],
): Promise<MakeRoomsPrivateResult> {
  return jsonRequest<MakeRoomsPrivateResult>(
    `/tenants/${encodeURIComponent(tenantId)}/private-channel-rooms/make-private`,
    "POST",
    { room_ids: roomIds },
  );
}

// ── Erasing a person ───────────────────────────────────────────────────────

export interface PersonClaimant {
  user_id: string;
  name: string;
}

/** `identity`: someone on a connected app, `id` is their platform identity.
 * `former`: someone on an app since disconnected, `id` is the sender id their
 * messages carry, and `bridge_name` is null. `member`: someone taking part
 * from Switch Console, `id` is their member client, `platform` is `switch` and
 * `bridge_name` is null; a deleted account's is named "Former member". */
export interface Person {
  id: string;
  kind: "identity" | "former" | "member";
  username: string;
  platform: string;
  bridge_name: string | null;
  message_count: number;
  claimed_by: PersonClaimant[];
}

export type ErasureState = "queued" | "running" | "done" | "failed";

export interface Erasure {
  id: string;
  state: ErasureState;
  identities: number;
  identities_erased: number;
  messages_deleted: number;
  files_deleted: number;
  error: string | null;
  requested_by_user_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function fetchPeople(tenantId: string): Promise<Person[]> {
  return jsonRequest<Person[]>(`/tenants/${encodeURIComponent(tenantId)}/people`, "GET");
}

export async function fetchErasures(tenantId: string): Promise<Erasure[]> {
  return jsonRequest<Erasure[]>(`/tenants/${encodeURIComponent(tenantId)}/erasures`, "GET");
}

export async function erasePeople(tenantId: string, people: Person[]): Promise<Erasure> {
  return jsonRequest<Erasure>(`/tenants/${encodeURIComponent(tenantId)}/erasures`, "POST", {
    external_user_ids: people.filter((p) => p.kind === "identity").map((p) => p.id),
    former_sender_ids: people.filter((p) => p.kind === "former").map((p) => p.id),
    member_client_ids: people.filter((p) => p.kind === "member").map((p) => p.id),
  });
}

export async function fetchInvitations(tenantId: string): Promise<Invitation[]> {
  return jsonRequest<Invitation[]>(
    `/tenants/${encodeURIComponent(tenantId)}/invitations`,
    "GET",
  );
}

export async function createInvitation(
  tenantId: string,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  return jsonRequest<CreatedInvitation>(
    `/tenants/${encodeURIComponent(tenantId)}/invitations`,
    "POST",
    input,
  );
}

export async function revokeInvitation(
  tenantId: string,
  invitationId: string,
): Promise<void> {
  await jsonRequest(
    `/tenants/${encodeURIComponent(tenantId)}/invitations/${encodeURIComponent(invitationId)}`,
    "DELETE",
  );
}

export async function acceptInvitation(token: string): Promise<TenantMembership> {
  return jsonRequest<TenantMembership>("/invitations/accept", "POST", { token });
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

/** Where an admin signs in to their organization's WorkOS account, for the
 * token a change to its members needs, and comes back to `returnTo`. */
// A dashboard path, and nothing that could leave it: no `//`, which a browser
// reads as another host. The server checks the same.
const DASHBOARD_PATH = /^\/(?!\/)[A-Za-z0-9/_.-]*$/;

export function organizationSignInUrl(returnTo: string): string {
  const path = DASHBOARD_PATH.test(returnTo) ? returnTo : "/organization";
  return `${BASE}/auth/workos/organization?return_to=${encodeURIComponent(path)}`;
}

/** The server's answer when a change to a linked organization's members
 * waits on the admin signing in to its WorkOS account. */
export function needsOrganizationSignIn(err: unknown): boolean {
  if (!(err instanceof ApiError) || !err.detail || typeof err.detail !== "object") return false;
  return (err.detail as Record<string, unknown>).error === "directory_sign_in_required";
}

/** Whether the change that asked for a sign-in had already taken away the
 * person's workspace access before it did. */
export function signInAfterAccessEnded(err: unknown): boolean {
  return (
    needsOrganizationSignIn(err) &&
    (err as ApiError & { detail: Record<string, unknown> }).detail.access_ended === true
  );
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

export async function fetchUsers(): Promise<ListedUser[] | null> {
  return fetchJson<ListedUser[]>("/users");
}

// The roles `POST /users` accepts; `admin` makes a deployment operator.
export type UserRole = "user" | "admin";

export async function createUser(
  name: string,
  email: string,
  password: string,
  role: UserRole,
): Promise<UserInfo> {
  return jsonRequest<UserInfo>("/users", "POST", { name, email, password, role });
}

// Deployment operator only. Deletes the whole account, as the person
// deleting it themselves would; the server refuses its own administrator
// account and the caller's own.
export async function deleteUser(userId: string): Promise<void> {
  await jsonRequest(`/users/${encodeURIComponent(userId)}`, "DELETE");
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
  // What the caller may do to it, as the server decides it. `can_edit` is
  // writing it; `can_manage` is deleting it, changing who may see or change
  // it, and handing it to someone else.
  can_edit: boolean;
  can_manage: boolean;
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
  // Of those, rooms the viewer may not read, which are never named to them.
  // Counted only for whoever may manage the resource; zero for anyone else.
  hidden_rooms_count: number;
  packages: string[];
  created_at: string;
  // Resolved server-side and unfiltered by the type's visibility. Null when
  // the slug resolves to no type at all.
  type_display_name: string | null;
  // What the caller may do to it, as the server decides it. `can_edit` is
  // writing it; `can_manage` is deleting it, changing who may see or change
  // it, and handing it to someone else.
  can_edit: boolean;
  can_manage: boolean;
  // Whether the viewer may open its page. A package's or a room's list names
  // a private item to everyone who may read the package or room.
  can_read: boolean;
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
  // Of those, rooms the viewer may not read, which are never named to them.
  // Counted only for whoever may manage the resource; zero for anyone else.
  hidden_rooms_count: number;
  packages: string[];
  scope: "global" | "room";
  room_id: string | null;
  created_by_agent_id: string | null;
  created_by_agent_name: string | null;
  created_at: string;
  // What the caller may do to it, as the server decides it. `can_edit` is
  // writing it; `can_manage` is deleting it, changing who may see or change
  // it, and handing it to someone else.
  can_edit: boolean;
  can_manage: boolean;
  // Handing it to someone else: never for a document scoped to one room.
  can_transfer: boolean;
  // As on `ReferenceDetail`.
  can_read: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
}

// Whether the viewer may remove a document from a room it is in: delete it if
// it is room-scoped (its creator, the room's owner, a workspace admin), unlink
// it if it is attached (those taking part in the room, a workspace admin).

/** A document as listed in a room it is in. */
export interface RoomDocumentSummary extends DocumentSummary {
  can_remove: boolean;
}

/** A document as seen from a room it is in. */
export interface RoomDocumentDetail extends DocumentDetail {
  can_remove: boolean;
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
  // Whether the viewer may unlink the resource from this room: they take part
  // in it, or are a workspace admin.
  can_unlink: boolean;
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

// The `load*` calls below throw the server's reason, where their `fetch*`
// twins answer null: a list or page that failed to load says why rather than
// passing for an empty one.

export async function loadReferenceTypes(): Promise<ReferenceTypeInfo[]> {
  return jsonRequest<ReferenceTypeInfo[]>("/references/reference-types", "GET");
}

/** Every stored type the caller may read, with what they may do to each. */
export async function loadOwnedReferenceTypes(): Promise<ReferenceTypeDetail[]> {
  return jsonRequest<ReferenceTypeDetail[]>("/references/reference-types/owned", "GET");
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

export async function loadReferences(): Promise<ReferenceDetail[]> {
  return jsonRequest<ReferenceDetail[]>("/references", "GET");
}

export async function loadReference(id: string): Promise<ReferenceDetail> {
  return jsonRequest<ReferenceDetail>(`/references/${id}`, "GET");
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

export async function loadReferenceRooms(id: string): Promise<ResourceRoom[]> {
  return jsonRequest<ResourceRoom[]>(`/references/${id}/rooms`, "GET");
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
    throw new Error(errorText(body?.detail ?? null, `${res.status} ${res.statusText}`));
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

export async function loadDocuments(): Promise<DocumentSummary[]> {
  return jsonRequest<DocumentSummary[]>("/documents", "GET");
}

export async function loadDocument(id: string): Promise<DocumentDetail> {
  return jsonRequest<DocumentDetail>(`/documents/${id}`, "GET");
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

export async function loadDocumentRooms(id: string): Promise<ResourceRoom[]> {
  return jsonRequest<ResourceRoom[]>(`/documents/${id}/rooms`, "GET");
}

export async function fetchRoomDocuments(
  roomId: string,
): Promise<RoomDocumentSummary[] | null> {
  return fetchJson<RoomDocumentSummary[]>(`/rooms/${roomId}/documents`);
}

export async function fetchRoomDocument(
  roomId: string,
  documentId: string,
): Promise<RoomDocumentDetail | null> {
  return fetchJson<RoomDocumentDetail>(`/rooms/${roomId}/documents/${documentId}`);
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
    throw new Error(errorText(body?.detail ?? null, `${res.status} ${res.statusText}`));
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
  // Of those, rooms the viewer may not read, which are never named to them.
  // Counted only for whoever may manage the resource; zero for anyone else.
  hidden_rooms_count: number;
  created_at: string;
  // Whether the caller may open the package. Only a room's package list
  // includes packages the caller cannot read.
  can_read: boolean;
  // What the caller may do to it, as the server decides it. `can_edit` is
  // writing it; `can_manage` is deleting it, changing who may see or change
  // it, and handing it to someone else.
  can_edit: boolean;
  can_manage: boolean;
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
  // The rooms that lost sight of the member, of those the viewer may read.
  affected_room_ids: string[];
  affected_room_names: string[];
  // How many more did among rooms the viewer may not read, never named.
  hidden_affected_rooms_count: number;
}

export async function fetchPackages(): Promise<PackageDetail[] | null> {
  return fetchJson<PackageDetail[]>("/packages");
}

export async function fetchPackage(id: string): Promise<PackageDetail | null> {
  return fetchJson<PackageDetail>(`/packages/${id}`);
}

export async function loadPackages(): Promise<PackageDetail[]> {
  return jsonRequest<PackageDetail[]>("/packages", "GET");
}

export async function loadPackage(id: string): Promise<PackageDetail> {
  return jsonRequest<PackageDetail>(`/packages/${id}`, "GET");
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

export async function loadPackageRooms(id: string): Promise<ResourceRoom[]> {
  return jsonRequest<ResourceRoom[]>(`/packages/${id}/rooms`, "GET");
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

export async function loadPackageReferences(id: string): Promise<ReferenceDetail[]> {
  return jsonRequest<ReferenceDetail[]>(`/packages/${id}/references`, "GET");
}

export async function loadPackageDocuments(id: string): Promise<DocumentSummary[]> {
  return jsonRequest<DocumentSummary[]>(`/packages/${id}/documents`, "GET");
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
    throw new Error(errorText(body?.detail ?? null, `${res.status} ${res.statusText}`));
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
    throw new Error(errorText(body?.detail ?? null, `${res.status} ${res.statusText}`));
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
    throw new Error(errorText(body?.detail ?? null, `${res.status} ${res.statusText}`));
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

export interface TemplateSummary {
  id: string;
  /** Null for a template that comes with Switch. */
  owner_id: string | null;
  owner_name: string | null;
  /** Comes with Switch: on every workspace, and changed by nobody. */
  official: boolean;
  name: string;
  description: string;
  kind: string;
  read_visibility: "public" | "private";
  write_visibility: "public" | "private";
  /** What the signed-in user may do with it, as the server judges it. */
  can_edit: boolean;
  can_manage: boolean;
  /** Why a person should not run it by hand (switch-buddy, which Switch
   * Console sets up itself); null when nothing stands in the way. */
  run_blocked_reason: string | null;
  /** How many times it has been run in this workspace, since runs were
   * first counted. */
  run_count: number;
  version: number;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface TemplateDetail extends TemplateSummary {
  content: string;
}

export interface TemplateCreateInput {
  name: string;
  description: string;
  kind: string;
  content: string;
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
}

export interface TemplateUpdateInput {
  name?: string;
  description?: string;
  kind?: string;
  content?: string;
  read_visibility?: "public" | "private";
  write_visibility?: "public" | "private";
}

export interface TemplateDeleteResult {
  deleted_id: string;
}

export interface TemplateFilter {
  /** Matched by the server against name and description. */
  q?: string;
  kind?: string;
  owner_id?: string;
}

/** The templates the signed-in user may see, narrowed on the server, or an
 * error carrying the server's reason. */
export async function fetchTemplates(
  filter: TemplateFilter = {},
): Promise<TemplateSummary[]> {
  const params = new URLSearchParams();
  const q = filter.q?.trim();
  if (q) params.set("q", q);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.owner_id) params.set("owner_id", filter.owner_id);
  const qs = params.toString();
  return jsonRequest<TemplateSummary[]>(`/templates${qs ? `?${qs}` : ""}`, "GET");
}

/** One template, or an error carrying the server's reason (403, 404, or the
 * network), which the page shows as it is. */
export async function fetchTemplate(id: string): Promise<TemplateDetail> {
  return jsonRequest<TemplateDetail>(`/templates/${id}`, "GET");
}

export async function createTemplate(
  input: TemplateCreateInput,
): Promise<TemplateDetail> {
  return jsonRequest<TemplateDetail>("/templates", "POST", input);
}

export async function updateTemplate(
  id: string,
  input: TemplateUpdateInput,
): Promise<TemplateDetail> {
  return jsonRequest<TemplateDetail>(`/templates/${id}`, "PATCH", input);
}

export async function deleteTemplate(id: string): Promise<TemplateDeleteResult> {
  return jsonRequest<TemplateDeleteResult>(`/templates/${id}`, "DELETE");
}

/** The stored document itself, exactly as uploaded — for download and copy. */
export async function fetchTemplateContent(id: string): Promise<string> {
  const res = await fetch(`${BASE}/templates/${id}/content`, {
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  // Decoded without BOM stripping: `text()` drops a leading byte order mark,
  // and the download promises the stored bytes.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await res.arrayBuffer(),
  );
}

export interface TemplateFinding {
  code: string;
  message: string;
  subject: string | null;
  blocking: boolean;
}

export interface TemplateValidation {
  ok: boolean;
  /** The server refuses an upload of this document. */
  blocked: boolean;
  errors: TemplateFinding[];
  warnings: TemplateFinding[];
}

/**
 * Check a document without storing it.
 *
 * Mostly advisory — but `blocked` is not. The server refuses an upload that
 * is not YAML at all, so a form that ignored it would offer a button that
 * always fails.
 */
export async function validateTemplate(
  content: string,
): Promise<TemplateValidation> {
  return jsonRequest<TemplateValidation>("/templates/validate", "POST", {
    content,
  });
}

// ── Workspace usage and budgets ─────────────────────────────────────────────

export interface CurrentTenant {
  id: string;
  slug: string;
  name: string;
  role: string;
  // Whether the caller may manage the workspace: an admin membership,
  // `org_admin` of its organization, or the operator bit.
  administers: boolean;
  // Whether they may delete it: an admin membership of their own, which the
  // organization admin's and the operator's reach do not count as, and never
  // the server's default workspace.
  can_delete: boolean;
  // Whether they may set a retention window and erase people's data: their
  // own admin membership, as for deleting it.
  can_manage_data_protection: boolean;
}

export type UsageMetric =
  | "messages"
  | "turns"
  | "input_tokens"
  | "output_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens";

export const USAGE_METRICS: UsageMetric[] = [
  "messages",
  "turns",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

// Messages and turns are not counted per model, so a budget on them covers
// every model and the server refuses one that names a model.
export const PER_MODEL_METRICS: UsageMetric[] = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

export interface UsageTotal {
  metric: UsageMetric;
  client_id: string;
  // Null when the client has since been deleted; its spend still counts.
  client_name: string | null;
  client_type: string | null;
  model: string;
  amount: number;
}

// The server's bounds on a budget: at most a leap year, and at most the largest
// integer a JavaScript number holds exactly.
export const MAX_BUDGET_PERIOD_HOURS = 8784;
export const MAX_BUDGET_AMOUNT = Number.MAX_SAFE_INTEGER;

export interface Budget {
  id: string;
  // Null covers every agent in the workspace.
  agent_id: string | null;
  agent_name: string | null;
  metric: UsageMetric;
  // Empty covers every model.
  model: string;
  amount_limit: number;
  period_hours: number;
  spent: number;
  resets_at: string;
  exhausted: boolean;
}

export interface BudgetCreate {
  agent_id: string | null;
  metric: UsageMetric;
  model: string;
  amount_limit: number;
  period_hours: number;
}

export interface BudgetUpdate {
  amount_limit: number;
  period_hours: number;
}

export async function fetchCurrentTenant(): Promise<CurrentTenant | null> {
  return fetchJson<CurrentTenant>("/tenants/current");
}

/** The current workspace as the server sees the caller in it. Throws rather
 * than answering null: what the dashboard lets someone open is worked out
 * from it, so a failed read must not look like "not an admin". */
export async function loadCurrentTenant(): Promise<CurrentTenant> {
  return jsonRequest<CurrentTenant>("/tenants/current", "GET");
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  const { flags } = await jsonRequest<{ flags: FeatureFlagState[] }>("/feature-flags", "GET");
  return featureFlagsFrom(flags);
}

export async function fetchUsage(
  tenantId: string,
  since: Date,
  until: Date,
): Promise<UsageTotal[] | null> {
  const params = new URLSearchParams({
    since: since.toISOString(),
    until: until.toISOString(),
  });
  return fetchJson<UsageTotal[]>(`/tenants/${tenantId}/usage?${params}`);
}

export async function fetchBudgets(tenantId: string): Promise<Budget[] | null> {
  return fetchJson<Budget[]>(`/tenants/${tenantId}/budgets`);
}

export async function createBudget(tenantId: string, body: BudgetCreate): Promise<Budget> {
  return jsonRequest<Budget>(`/tenants/${tenantId}/budgets`, "POST", body);
}

export async function updateBudget(
  tenantId: string,
  budgetId: string,
  body: BudgetUpdate,
): Promise<Budget> {
  return jsonRequest<Budget>(`/tenants/${tenantId}/budgets/${budgetId}`, "PUT", body);
}

export async function deleteBudget(tenantId: string, budgetId: string): Promise<void> {
  const res = await fetch(`${BASE}/tenants/${tenantId}/budgets/${budgetId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(errorText(detail?.detail, `${res.status} ${res.statusText}`));
  }
}

// ── Service connections and grants ───────────────────────────────────────────

/** A grant giving an agent access to its owner's connection to a service. */
export interface ServiceGrant {
  service: string;
  name: string;
  access: "read" | "write";
  tool_mode: "allow" | "deny";
  tools: string[];
  effective_tools: string[];
  resources: Record<string, unknown>;
  /** What the grant lets the agent do, in a sentence. */
  summary: string;
}

export interface ServiceGrants {
  grants: ServiceGrant[];
  /** Whether anyone can address the agent, and so use its grants. */
  addressing_open: boolean;
}

/** The agent's grants; only its owner may read them. */
export async function fetchServiceGrants(agentId: string): Promise<ServiceGrants> {
  return jsonRequest<ServiceGrants>(`/agents/${agentId}/service-grants`, "GET");
}

/**
 * Create or replace the agent's grant on a service. `warning` is set when
 * what the old grant gave out stays usable for a while.
 */
export async function setServiceGrant(
  agentId: string,
  service: string,
  grant: { access: "read" | "write" | null; resources: Record<string, unknown> },
): Promise<{ grant: ServiceGrant; warning: string | null }> {
  // An on/off grant names no level: Switch gives it the connection's.
  const body = grant.access === null ? { resources: grant.resources } : grant;
  return jsonRequest(`/agents/${agentId}/service-grants/${service}`, "PUT", body);
}

/** A catalog service, with the signed-in person's connection to it. */
export interface ServiceConnection {
  slug: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  connectable: boolean;
  /** Why the service cannot be granted to agents on this server; null when it can. */
  unavailable_reason: string | null;
  /** Whether it waits on the server's operator setting up its app under Connectors. */
  server_setup_needed: boolean;
  /** Whose app it signs in through here: the workspace's organization's own, or the server's. */
  app_source: "organization" | "server";
  /**
   * Why it can be granted for reading only here (its GitHub App lacks the
   * write permissions), said beside the write choice it disables; null where
   * writing can be granted too.
   */
  read_only_reason: string | null;
  status: "not_connected" | "active" | "needs_reauthorization";
  /** Whether a grant hands the agent the owner's own token: on or off, at the connection's level. */
  pass_through: boolean;
  /** The longest a token handed out lives, in seconds; null when the catalog does not say. */
  token_lifetime: number | null;
  /** What a person pastes to connect a service connected with a key, and
   * where they make one; null for any other. */
  key: ServiceKeyForm | null;
  auth_type: "oauth" | "api_key";
  /** Whether the server can grant it here; `unavailable_reason` says why not. */
  configured: boolean;
  unavailable_code: string | null;
  /** Who makes it, and its own pages; null for one not built yet. */
  publisher: string | null;
  links: { documentation: string; support: string; privacy: string } | null;
  /** The vendor's MCP servers its agents' sessions call, if any. */
  mcp_urls: string[];
  /** Whether it is on in this workspace. */
  workspace_enabled: boolean;
  /** The workspace's organization locked it on or off, out of the workspace admin's reach. */
  organization_locked: boolean;
  /** Which setting `workspace_enabled` comes from; null where workspaces have no switch. */
  decided_by: WorkspaceServiceDecider | null;
  /** The level the person allowed when connecting; null while not connected. */
  consent: "read" | "write" | null;
  /** The account connected, as the vendor names it. */
  external_identity: string | null;
  /** Whether the person may disconnect it: their own, while they have one. */
  can_revoke: boolean;
}

/** One value a person pastes (a key: secret) or picks (a site, among `choices`) to connect. */
export interface ServiceKeyField {
  name: string;
  label: string;
  secret: boolean;
  help: string | null;
  choices: string[] | null;
}

export interface ServiceKeyForm {
  fields: ServiceKeyField[];
  help_url: string | null;
}

/** Every catalog service and the signed-in person's connection to it. */
export async function fetchServiceConnections(): Promise<ServiceConnection[]> {
  return (await jsonRequest<{ connections: ServiceConnection[] }>("/service-connections", "GET"))
    .connections;
}

/** Why nobody in a workspace can use a service: `UnavailableCode` in
 * `core/switch_core/connections/broker.py`. A server newer than this
 * dashboard may send one it doesn't know yet. */
export type UnavailableCode =
  | "coming_soon"
  | "switched_off"
  | "needs_https"
  | "needs_public_url"
  | "app_not_set_up"
  | "not_set_up"
  | "organization_app_unusable"
  | "not_fully_set_up"
  | "key_never_expires";

/** Which setting decides whether a service is on in the workspace. */
export type WorkspaceServiceDecider =
  | "organization_locked"
  | "workspace"
  | "organization_default"
  | "workspace_default";

/** A catalog service as the workspace's settings show it: on or off here, and why. */
export interface WorkspaceService {
  slug: string;
  name: string;
  category: string;
  description: string;
  auth_type: "oauth" | "api_key";
  enabled: boolean;
  decided_by: WorkspaceServiceDecider;
  organization_locked: boolean;
  /** The organization's unlocked setting, which applies once the workspace drops its own; null where it has none. */
  organization_default: boolean | null;
  /** Whether the caller may switch it here: an admin, on a service the organization has not locked. */
  can_change: boolean;
  /** Who made the setting that decides it; null for the workspace's default or a deleted account. */
  updated_by_name: string | null;
  updated_at: string | null;
  /** Whether the workspace's admin set it themselves. */
  workspace_set: boolean;
  /** Whose app it signs in through here: the workspace's organization's own, or the server's. */
  app_source: "organization" | "server";
  /** Why nobody here can use it whatever the switch says; null when they can. */
  unavailable_reason: string | null;
  unavailable_code: string | null;
  /** How many people have connected it and agents are granted it; null for anyone but an admin. */
  connected_members: number | null;
  granted_agents: number | null;
}

export interface WorkspaceServices {
  /** Whether the caller administers the workspace, and so may switch what isn't locked. */
  can_change: boolean;
  /** Whether a service nobody has set is on here. */
  on_by_default: boolean;
  /** The workspace's organization, where it has a say in connectors; null where it has none. */
  organization_name: string | null;
  services: WorkspaceService[];
}

export async function fetchWorkspaceServices(): Promise<WorkspaceServices> {
  return jsonRequest<WorkspaceServices>("/workspace/services", "GET");
}

/** Switch a service on or off for the workspace; `warning` says what could not be revoked yet. */
export async function setWorkspaceService(
  service: string,
  enabled: boolean,
): Promise<{ warning: string | null }> {
  return jsonRequest(`/workspace/services/${service}`, "PUT", { enabled });
}

/** Drop the workspace's own setting, so its organization's default applies. */
export async function clearWorkspaceService(service: string): Promise<{ warning: string | null }> {
  return jsonRequest(`/workspace/services/${service}`, "DELETE");
}

export async function removeServiceGrant(
  agentId: string,
  service: string,
): Promise<{ warning: string | null }> {
  return jsonRequest(`/agents/${agentId}/service-grants/${service}`, "DELETE");
}

export interface GitHubRepository {
  id: number;
  name: string;
}

export interface GitHubInstallation {
  id: number;
  account: string;
  repositories: GitHubRepository[];
}

/** The signed-in person's GitHub connection, and the repositories the App lets them reach. */
export type GitHubConnection =
  | { status: "not_connected"; install_url: string }
  | {
      status: "connected";
      login: string;
      install_url: string;
      installations: GitHubInstallation[];
    };

export async function fetchGitHubConnection(): Promise<GitHubConnection> {
  return jsonRequest<GitHubConnection>("/provider-connections/github", "GET");
}

/**
 * Owner-only addressing: the owner alone, none of the owner's agents, as
 * Switch Console sends it. What the grant screens offer when others can
 * address an agent with grants: an agent the owner runs could pass on a
 * request someone else gave it.
 */
export const OWNER_ONLY_POLICY: AddressingPolicy = {
  rules: [
    {
      rooms: "*",
      room_groups: "*",
      users: [],
      agents: [],
      owner: true,
      owner_agents: false,
    },
  ],
};

// ── Connector app credentials (the server's operator only) ───────────────

export type ConnectorAppKind = "github_app" | "oauth_client";
export type ConnectorAppField = "client_id" | "client_secret" | "private_key";

/** Whether a secret is set, and how the operator recognises it; never the secret. */
export interface ConnectorAppSecret {
  set: boolean;
  /** A client secret's last four characters. */
  last4?: string | null;
  /** A private key's SHA-256 fingerprint, as GitHub lists it. */
  fingerprint?: string | null;
}

/** The app one connector signs in through, and where it comes from. */
export interface ConnectorApp {
  slug: string;
  name: string;
  kind: ConnectorAppKind;
  source: "configuration" | "saved" | "none";
  /** The variables that set it from configuration. */
  configuration_variables: string[];
  /** GitHub's HOSTED_GITHUB_CONFIG_PATH: no private key, so it can't be copied. */
  deprecated: boolean;
  client_id: string | null;
  /** The client saved here, when there is one. */
  saved_client_id: string | null;
  fields: { slug?: string | null };
  secrets: Record<string, ConnectorAppSecret>;
  /** Saved here, but configuration is set, so Switch uses that. */
  saved_ignored: boolean;
  /** Saved here under a key the server no longer has. */
  unreadable: boolean;
  /** Why the app saved here can't be used. */
  load_error: string | null;
  /** Where the vendor sends people back to Switch; null without a GATEWAY_PUBLIC_URL it accepts. */
  redirect_uri: string | null;
  /** Every address to register at the vendor: Core's own callback, or one per port of Switch Console's listener. */
  redirect_uris: string[];
  /** Whether the vendor sends people back to the server, so it needs GATEWAY_PUBLIC_URL. */
  needs_public_url: boolean;
  /** The scopes a sign-in asks for, where the vendor's app must list them. */
  scopes: string[];
  /** Why it can't be set up here, before any vendor is asked; null when nothing stops it. */
  setup_blocked: string | null;
  /**
   * A GitHub App short of the write permissions, as GitHub last answered:
   * agents can only read through it, and a write grant is refused.
   */
  read_only: boolean;
  /** The permissions it lacks to write, as the App's settings page names them. */
  lacks_write: string[];
  install_url: string | null;
  /** When the app saved here was first saved; null with none saved. */
  created_at: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
  connected_members: number;
  workspaces: number;
  /** Agents' grants on the connections made through the app in use. */
  agent_grants: number;
  /** Connections made through an app this server no longer uses. */
  stale_connections: number;
  /** An organization's page only: whether the server has an app its
   * workspaces use while the organization saves none of its own. */
  server_app?: boolean;
}

/** The server's connector apps; a service that needs no app of the operator's is not listed. */
export interface ConnectorApps {
  public_url: string | null;
  apps: ConnectorApp[];
}

export interface ConnectorAppCheck {
  name: string;
  ok: boolean;
  message: string;
  field: ConnectorAppField | null;
  /** What the check could not see, for the operator to confirm themselves. */
  note: string | null;
}

export interface SaveConnectorAppInput {
  client_id: string;
  client_secret?: string;
  private_key?: string;
  /** Switching to another app on purpose: everyone connected must reconnect. */
  replace: boolean;
}

export interface ConnectorAppImpact {
  connected_members: number;
  workspaces: number;
  agent_grants: number;
}

/** A save the vendor refused: what it said, and the value to look at again. */
export class ConnectorAppRefusal extends ApiError {
  readonly field: ConnectorAppField | null;

  constructor(status: number, message: string, field: ConnectorAppField | null) {
    super(status, message, message);
    this.name = "ConnectorAppRefusal";
    this.field = field;
  }
}

/** What the operator reads when the server has no connector-apps routes:
 * they are mounted only with the `service_connections` flag. */
export const CONNECTORS_NOT_ENABLED =
  "Connectors aren't turned on here. An operator turns them on by adding service_connections to FEATURE_FLAGS_ENABLED.";

/** Whose apps a page manages: the server's, its operator's alone, or the
 * current workspace's organization's, its org admins'. */
export type ConnectorAppScope = "server" | "organization";

const CONNECTOR_APPS_PATH: Record<ConnectorAppScope, string> = {
  server: "/connector-apps",
  organization: "/organizations/current/connector-apps",
};

export async function fetchConnectorApps(scope: ConnectorAppScope): Promise<ConnectorApps> {
  return jsonRequest<ConnectorApps>(CONNECTOR_APPS_PATH[scope], "GET");
}

/** A saved app, and what the vendor said when Switch checked it; none from an older server. */
export interface SavedConnectorApp {
  app: ConnectorApp;
  checks: ConnectorAppCheck[];
}

export async function saveConnectorApp(
  scope: ConnectorAppScope,
  service: string,
  input: SaveConnectorAppInput,
): Promise<SavedConnectorApp> {
  const res = await fetch(`${BASE}${CONNECTOR_APPS_PATH[scope]}/${service}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.detail ?? null;
    const message = errorText(detail, `${res.status} ${res.statusText}`);
    if (res.status === 422 && payload && "checks" in payload) {
      throw new ConnectorAppRefusal(res.status, message, payload.field ?? null);
    }
    throw new ApiError(res.status, detail, message);
  }
  const { checks, ...app } = payload as ConnectorApp & { checks?: ConnectorAppCheck[] };
  return { app, checks: checks ?? [] };
}

export async function importConnectorApp(service: string): Promise<ConnectorApp> {
  return jsonRequest<ConnectorApp>(`/connector-apps/${service}/import`, "POST");
}

export async function checkConnectorApp(
  scope: ConnectorAppScope,
  service: string,
): Promise<{ ok: boolean; checks: ConnectorAppCheck[] }> {
  return jsonRequest(`${CONNECTOR_APPS_PATH[scope]}/${service}/check`, "POST");
}

export async function fetchConnectorAppImpact(
  scope: ConnectorAppScope,
  service: string,
  clientId: string,
): Promise<ConnectorAppImpact> {
  const params = new URLSearchParams({ client_id: clientId });
  return jsonRequest<ConnectorAppImpact>(
    `${CONNECTOR_APPS_PATH[scope]}/${service}/impact?${params}`,
    "GET",
  );
}

export async function removeConnectorApp(
  scope: ConnectorAppScope,
  service: string,
): Promise<ConnectorAppImpact> {
  return jsonRequest<ConnectorAppImpact>(`${CONNECTOR_APPS_PATH[scope]}/${service}`, "DELETE");
}

// ── Who uses a connector, from its page ──────────────────────────────────

/** One of the signed-in person's own agents, and its grant on a connector. */
export interface ServiceAgent {
  agent_id: string;
  name: string;
  granted: boolean;
  grant: ServiceGrant | null;
  /** Whether Switch Console runs it, so it can be granted a connector at all. */
  grantable: boolean;
  /** Others can address it, so they could have it act as its owner. */
  addressing_open: boolean;
}

export async function fetchServiceAgents(service: string): Promise<ServiceAgent[]> {
  return jsonRequest<ServiceAgent[]>(`/service-connections/${service}/agents`, "GET");
}

/** Someone connected to a connector in this workspace, as its admins see them. */
export interface ConnectedPerson {
  user_id: string;
  name: string;
  status: Exclude<ServiceConnection["status"], "not_connected">;
  connected_at: string;
  /** How many of their agents are granted it. */
  agents: number;
  /** Someone else's: an admin's own is disconnected, not revoked. */
  can_revoke: boolean;
}

/** An agent granted a connector in this workspace, whoever owns it. */
export interface GrantedAgent {
  agent_id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  grant: ServiceGrant;
  /** Others than its owner can address it, and so have it act as its owner. */
  addressing_open: boolean;
}

export interface ServiceInWorkspace {
  people: ConnectedPerson[];
  agents: GrantedAgent[];
}

/** Who uses a connector in this workspace: its admins only. */
export async function fetchServiceInWorkspace(service: string): Promise<ServiceInWorkspace> {
  return jsonRequest<ServiceInWorkspace>(`/service-connections/${service}/workspace`, "GET");
}

/** End someone else's connection, as a workspace admin. */
export async function revokeServiceConnection(
  service: string,
  userId: string,
): Promise<{ warning: string | null }> {
  return jsonRequest(`/service-connections/${service}/people/${userId}`, "DELETE");
}

/** End your own connection; `warning` names what could not be revoked. */
export async function disconnectService(service: string): Promise<{ warning: string | null }> {
  return jsonRequest(`/service-connections/${service}`, "DELETE");
}

/** Connect a key-based connector, or replace its key, once the vendor accepts it. */
export async function connectServiceWithKey(
  service: string,
  fields: Record<string, string>,
): Promise<{ warning: string | null; external_identity: string }> {
  return jsonRequest(`/service-connections/${service}/key`, "PUT", { fields });
}
