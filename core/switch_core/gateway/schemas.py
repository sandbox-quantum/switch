from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from switch_core.addressing import AddressingPolicy
from switch_core.bridges.collaboration.models import BridgeInstallLink

# ── Rooms ─────────────────────────────────────────────────────────────────────


class RoomRoleSpec(BaseModel):
    """A room-role definition (assumable instruction bundle)."""

    name: str
    instructions: str
    exclusive: bool = False


class RoomRoleDetail(RoomRoleSpec):
    """A room-role with its current live holders (agent names; empty if free).

    A shared (non-exclusive) role may have several concurrent holders; an
    exclusive role has at most one.
    """

    held_by: list[str] = []


class RoomRoleCreateRequest(RoomRoleSpec):
    pass


class RoomRoleUpdateRequest(BaseModel):
    instructions: str | None = None
    exclusive: bool | None = None


class RoomSummary(BaseModel):
    id: str
    name: str
    description: str
    channel_type: str | None
    admin_mode: bool
    agent_count: int
    connected_user_count: int
    connected_user_names: list[str]
    bridge_id: str | None
    bridge_display_name: str | None
    # Bridge platform type (e.g. "slack", "mattermost") when bridged, else null.
    # Stable identifier, unlike the user-chosen display name.
    bridge_type: str | None = None
    # Native deeplink that opens this room's external channel in the messaging
    # app's desktop client (e.g. slack://channel?…, mattermost://…). Null when
    # the room isn't bridged, the bridge isn't running, or the platform has no
    # such scheme. Built by the live collaboration adapter.
    external_channel_url: str | None = None
    # The group this room belongs to, or null if standalone.
    group_id: str | None = None
    group_name: str | None = None
    owner_id: str | None = None
    owner_name: str | None = None
    read_visibility: str = "public"
    write_visibility: str = "public"
    created_at: str
    # True when the room is archived (hidden from the default active list).
    archived: bool = False


class RoomDetail(RoomSummary):
    matrix_room_id: str
    external_channel_id: str | None
    instructions: str | None
    protection_config: dict[str, Any] | None
    observe_config: dict[str, Any] | None
    agent_ids: list[str]
    agent_statuses: dict[str, str]
    roles: list[RoomRoleDetail] = []
    # Agent ids configured to receive `room_join` events in this room.
    join_event_listeners: list[str] = []
    # ISO timestamp of when the room was archived, or null if active.
    archived_at: str | None = None


class RoomCreateRequest(BaseModel):
    name: str
    description: str
    instructions: str | None = None
    channel_type: str | None = None
    agent_ids: list[str] | None = None
    agent_names: list[str] | None = None
    # Per-agent opt-in: ids (subset of agent_ids) whose subagents to also add.
    include_subagents_for: list[str] | None = None
    # Per-agent opt-in: ids (subset of agent_ids) that should receive
    # `room_join` events in this room. Others default to off.
    join_event_listeners: list[str] | None = None
    user_names: list[str] | None = None
    bridge_id: str | None = None
    # Opt out of the instance default bridge: create a room with no external
    # channel. Ignored when bridge_id is set.
    internal_only: bool = False
    external_channel_id: str | None = None
    group_id: str | None = None
    read_visibility: str = "public"
    write_visibility: str = "public"
    roles: list[RoomRoleSpec] | None = None


class RoomUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    admin_mode: bool | None = None
    read_visibility: str | None = None
    write_visibility: str | None = None


class RoomSetGroupRequest(BaseModel):
    # The group to move the room into. `null` makes the room standalone.
    group_id: str | None = None


class RoomAgentsRequest(BaseModel):
    agent_ids: list[str]
    # Per-agent opt-in: ids (subset of agent_ids) whose subagents to also add.
    include_subagents_for: list[str] | None = None
    # Per-agent opt-in: ids (subset of agent_ids) that should receive
    # `room_join` events in this room. Others default to off.
    join_event_listeners: list[str] | None = None


class RoomAgentUpdateRequest(BaseModel):
    # Whether this agent receives `room_join` events in the room.
    receives_join_events: bool


class RoomUsersRequest(BaseModel):
    user_names: list[str]


class RoomProtectionRequest(BaseModel):
    protection_config: dict[str, Any]


class RoomObserveRequest(BaseModel):
    observe_config: dict[str, Any]


class BulkDeleteRequest(BaseModel):
    room_ids: list[str]


class BulkDeleteResponse(BaseModel):
    deleted: int


class BulkArchiveRequest(BaseModel):
    room_ids: list[str]
    # True archives the rooms, False unarchives them.
    archived: bool


class BulkArchiveResponse(BaseModel):
    updated: int


# ── Room groups ───────────────────────────────────────────────────────────────


class RoomGroupDetail(BaseModel):
    id: str
    name: str
    description: str | None
    color: str | None
    parent_group_id: str | None
    # Number of rooms directly assigned to this group (not counting subgroups).
    room_count: int
    created_at: str


class RoomGroupCreateRequest(BaseModel):
    name: str
    description: str | None = None
    color: str | None = None
    parent_group_id: str | None = None


class RoomGroupAssignRequest(BaseModel):
    # Rooms to (re)assign into the group. Rooms already in another group are
    # moved; rooms already in this group are a no-op.
    room_ids: list[str]


class RoomGroupAssignResponse(BaseModel):
    assigned: int


class RoomGroupUpdateRequest(BaseModel):
    # All optional. `parent_group_id` is only applied when the key is present in
    # the request body, so callers can reparent to a group, reparent to top-level
    # (`null`), or leave the parent unchanged (omit the key entirely). The
    # endpoint distinguishes these via `model_fields_set`.
    name: str | None = None
    description: str | None = None
    color: str | None = None
    parent_group_id: str | None = None


# ── Agents ────────────────────────────────────────────────────────────────────


class AgentSummary(BaseModel):
    id: str
    name: str
    description: str
    # Absolute https URL of the agent's icon, or null when none is set. Null is
    # not an error: the caller renders its own fallback rather than Switch
    # inventing a default, so the fallback can change without a data migration.
    icon_url: str | None = None
    connector_type: str
    connection_model: str | None
    tool_count: int
    model_count: int
    owner_id: str | None = None
    owner_name: str | None
    oauth_client_id: str | None
    created_at: str
    # Set when this agent is a child of another (e.g. a Claude Code subagent
    # under the user's main agent). The UI nests children under their parent.
    parent_agent_id: str | None = None
    # `known_agent_type` is set when this agent was registered via
    # `/agents/register` with one of the KNOWN_AGENTS specs (e.g. "claude-code").
    # `known_agent_options` is the last validated options payload. Together
    # they let the UI render an "edit options" form against the spec's schema.
    known_agent_type: str | None = None
    known_agent_options: dict[str, Any] | None = None
    # Scoped agent-addressing permissions. null → open (anyone may address the
    # agent); otherwise the allow-list that governs who can. On the summary,
    # not just the detail, so a caller can tell which of someone's agents are
    # owner-restricted without fetching each one — the console warns about
    # exactly that, and per-agent reads would make it a request storm.
    addressing_policy: AddressingPolicy | None = None


class AgentToolSummary(BaseModel):
    name: str
    description: str


class AgentModelSummary(BaseModel):
    name: str
    description: str


class AgentRoomMembership(BaseModel):
    """A room the agent belongs to, with the agent's presence status there.

    `status` is the same value the room detail page shows for this agent
    (live / no_session / disconnected / awaiting_manual_poll). `room_role` is
    the room-scoped role the agent currently (live-lease) holds there, or null
    if it holds none.
    """

    room_id: str
    room_name: str
    archived: bool
    status: str
    room_role: str | None


class AgentSessionDetail(BaseModel):
    """One row of the agent's session table.

    `state` is derived from `lifecycle` + heartbeat freshness:
    - `live`  — heartbeat row within its connection model's TTL
    - `stale` — heartbeat row whose last beat is older than the TTL
    - `open`  — explicit (session_passive) row; liveness is not heartbeat-driven

    A session_addressable agent is only meaningfully attending a room while its
    session is `live`; a `stale` row is a left-over binding, not a live presence.
    `room_id`/`room_name` are null for an always_on agent's room-agnostic row.
    """

    room_id: str | None
    room_name: str | None
    lifecycle: str
    state: str
    last_seen_at: str


class AgentDetail(AgentSummary):
    agent_type: str
    integration_profile: dict[str, Any]
    tools: list[AgentToolSummary]
    models: list[AgentModelSummary]
    rooms: list[AgentRoomMembership]
    sessions: list[AgentSessionDetail]
    children: list[AgentSummary]


class UpdateAddressingPolicyRequest(BaseModel):
    """Set (or clear) an agent's scoped addressing policy.

    ``policy: null`` clears it — the agent becomes open to anyone again."""

    policy: AddressingPolicy | None = None


class UpdateAgentIconRequest(BaseModel):
    """Set (or clear) an agent's icon.

    ``icon_url: null`` clears it — the agent falls back to whatever default the
    caller renders. The field is required rather than defaulted so that
    clearing an icon is always something the client said, never something it
    forgot to send."""

    icon_url: str | None


class KnownAgentType(BaseModel):
    key: str
    connector_type: str
    tool_count: int
    options_schema: dict[str, Any]


class RegisterKnownAgentRequest(BaseModel):
    agent_type: str
    name: str
    description: str
    # Optional at registration: an agent may be given its icon later, and a
    # re-registration that omits it keeps whatever icon the agent already has
    # rather than clearing it.
    icon_url: str | None = None
    options: dict[str, Any] = {}
    overwrite: bool = False


class BulkSubagentSpec(BaseModel):
    """One Claude Code subagent to register under a parent agent.

    `subagent_name` is the bare Claude Code subagent identifier (the `name`
    frontmatter field, used for the `--agent <name>` launch flag); the Switch
    agent name is derived server-side as `<parent-name>.<subagent_name>`.
    """

    subagent_name: str
    description: str


class RegisterKnownSubagentsRequest(BaseModel):
    """Register many Claude Code subagents under one parent agent.

    Session-authed counterpart of the agent-bridge `register-known-bulk`
    endpoint: the caller must own the parent. `options` is the shared base
    applied to every subagent (the per-subagent `subagent_name` is merged on
    top); when omitted, each subagent inherits the parent's `channels_enabled`
    and `repo_dir`.
    """

    agent_type: str
    parent_agent_id: str
    options: dict[str, Any] = {}
    subagents: list[BulkSubagentSpec]
    overwrite: bool = False


class BulkRegisterResult(BaseModel):
    subagent_name: str
    name: str
    id: str
    api_key: str


class RegisterKnownSubagentsResponse(BaseModel):
    results: list[BulkRegisterResult]


class UpdateAgentOptionsRequest(BaseModel):
    """Full-replacement update of a known-agent's options.

    The body must contain every option the spec defines (no partial merge).
    The new options are validated against the spec's `options_schema`, and
    the agent's `integration_profile` is rebuilt from them — keeping the
    two consistent the same way `register-known` does at registration.
    """

    options: dict[str, Any]


class RegisterOtherAgentRequest(BaseModel):
    name: str
    description: str
    icon_url: str | None = None
    overwrite: bool = False


class RegisterAgentResponse(BaseModel):
    id: str
    api_key: str
    oauth_client_id: str | None = None


# ── API Keys ────────────────────────────────────────────────────────────────


class CreateApiKeyRequest(BaseModel):
    label: str


class ApiKeyDetail(BaseModel):
    id: str
    label: str
    type: str
    key_prefix: str
    created_at: str


class CreateApiKeyResponse(BaseModel):
    id: str
    label: str
    key: str
    created_at: str


class RevealKeyResponse(BaseModel):
    key: str


# ── Collaborations ───────────────────────────────────────────────────────────


class BridgeDetail(BaseModel):
    bridge_id: str
    bridge_type: str
    display_name: str
    status: str
    agent_greetings_enabled: bool
    is_default: bool
    room_count: int
    created_at: str
    # Link that opens this bridge's workspace in its messaging app, built by
    # the live adapter. None when the bridge is not running, or the platform
    # offers no such link. Never carries a credential — only ids that the
    # platform already puts in its own URLs.
    home_url: str | None = None
    # One-click links that add this bridge's app to a chat, from the live
    # adapter. Empty when the bridge is not running or the platform has no such
    # link, in which case installation stays a documented manual flow.
    install_links: list[BridgeInstallLink] = Field(default_factory=list)
    # What those links do not cover, in the platform's own terms — the kinds of
    # chat that have to be joined by hand. None when there is nothing to add.
    install_note: str | None = None
    # Whether the platform can create a channel from Switch at all, and whether
    # an operator permits this connection to. The two are separate so a UI can
    # tell "your organisation turned this off" (changeable here) from "Telegram
    # has no such call" (not changeable anywhere) — the first is a disabled
    # switch you can flip, the second a disabled switch with a reason.
    channel_creation_supported: bool = True
    channel_creation_enabled: bool = True
    # Whether the platform has a user directory Switch can search. False where
    # the only people Switch can name are those who have spoken to it, which
    # makes "pick yourself from the directory" an empty list on a connection
    # nobody has used yet — a question worth not asking rather than asking
    # badly.
    directory_search_supported: bool = True


class BridgeUpdateRequest(BaseModel):
    # All optional so a caller can change one without restating the others; a
    # request that sets none changes nothing rather than silently resetting
    # a field it did not mention.
    agent_greetings_enabled: bool | None = None
    channel_creation_enabled: bool | None = None
    # Merged over the stored config, not substituted for it, so changing one
    # setting does not mean re-sending the platform's secrets. The merged
    # result is validated against the bridge type's schema before it is kept,
    # and the bridge is restarted so the change actually takes effect.
    connection_config: dict[str, object] | None = None


class BridgeTypeInfo(BaseModel):
    key: str
    config_schema: dict[str, Any]
    # Whether this platform can create channels at all. Read from the adapter
    # class, so it is answerable before any connection of this type exists —
    # which is exactly when the registration form needs it.
    channel_creation_supported: bool = True
    # Likewise for its user directory: read here because the connect flow has
    # to decide whether to offer the "which account is you" step for a
    # connection that does not exist yet.
    directory_search_supported: bool = True


class BridgeCreateRequest(BaseModel):
    bridge_type: str
    display_name: str
    connection_config: dict[str, object]
    # Nominate this bridge as the one new rooms land on when none is named.
    # Set by the headless standalone bootstrap so a fresh deployment bridges
    # rooms out of the box.
    set_as_default: bool = False
    # Whether this connection may create channels on the platform. Defaults on
    # to keep existing callers behaving as they did; registration rejects it
    # for a platform that cannot, rather than storing a claim it cannot honour.
    channel_creation_enabled: bool = True


class IdentityClaimant(BaseModel):
    """A Switch user who says a platform account is theirs."""

    user_id: str
    user_name: str


class ExternalUserSummary(BaseModel):
    id: str
    bridge_id: str
    external_user_id: str
    external_username: str
    # Everyone who has claimed this platform account. A list, not one user:
    # claiming is not exclusive, so an account shared by several Switch users
    # satisfies an owner rule for any of them.
    claimed_by: list[IdentityClaimant] = []


class DirectoryUserSummary(BaseModel):
    """Someone found in the messaging platform's own directory, and whether
    Switch already knows them."""

    external_user_id: str
    username: str
    display_name: str
    email: str | None = None
    # Set when this person has already spoken on the bridge and so has an
    # ExternalUser row; claiming reuses it rather than creating a duplicate.
    known_external_user_id: str | None = None
    # Who has already claimed this account. Shown so a picker can say the
    # account is spoken for, not to stop anyone else claiming it too.
    claimed_by: list[IdentityClaimant] = []


class DirectorySearchResponse(BaseModel):
    """Who a search turned up, and which of the two possible sources answered.

    `source` is not decoration. A platform whose directory cannot be searched
    falls back to the accounts Switch has already seen, which is a genuinely
    narrower answer: someone who has never spoken is absent from it, and a
    caller that presented it as a whole-workspace search would be telling the
    user that person does not exist. `note` carries the platform's own
    explanation, for showing alongside the results rather than instead of them.
    """

    source: Literal["directory", "known"]
    note: str | None = None
    users: list[DirectoryUserSummary] = []


class ClaimIdentityRequest(BaseModel):
    """Claim a platform identity for a Switch user.

    `external_user_id` is the platform's own id (a Slack `U…`, a Mattermost
    user id), not an `ExternalUser.id` — that row may not exist yet for
    someone who has never posted, and is created on demand.
    """

    external_user_id: str
    username: str
    # Omitted means "claim it for me"; only an admin may claim on behalf of
    # someone else.
    user_id: str | None = None


class LinkedIdentity(BaseModel):
    """One platform identity claimed by a Switch user."""

    id: str
    bridge_id: str
    bridge_display_name: str
    bridge_type: str
    external_user_id: str
    external_username: str


# ── Server-Side Connectors ──────────────────────────────────────────────────


class ConnectorTypeInfo(BaseModel):
    key: str
    config_schema: dict[str, Any]


class CreateConnectorRequest(BaseModel):
    type: str
    display_name: str
    connection_config: dict[str, object]


class ConnectorDetail(BaseModel):
    connector_id: str
    connector_type: str
    display_name: str
    status: str
    agent_names: list[str]
    created_at: str


# ── Auth ─────────────────────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: str
    name: str
    email: str
    role: str
    created_at: str


class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "user"


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class AuthConfigResponse(BaseModel):
    # Read unauthenticated by the login page to decide which login methods to
    # show. `oidc_provider_label` is the button text (e.g. "Okta").
    #
    # Nothing version-related may be added here: this is the one gateway
    # response served without a session, and version disclosure is
    # authenticated everywhere (CHOO-1865).
    password_login_enabled: bool
    oidc_enabled: bool
    oidc_provider_label: str | None


class ContractRangeResponse(BaseModel):
    """The revisions of one contract this server implements and still handles."""

    speaks: int
    accepts: int


class ServerDeclaration(BaseModel):
    """What switch-core says about itself to an authenticated client.

    `version` is null when switch-core cannot read its own version. Null means
    unknown and must be rendered as such — never as current.
    """

    version: str | None
    contracts: dict[str, ContractRangeResponse]


class SessionUserResponse(UserResponse):
    """The authenticated user, plus what the server is (CHOO-1865).

    The server's declaration rides the session response rather than sitting on
    an endpoint of its own, because the authentication surface is deliberately
    frozen — never versioned, permanently backward-compatible, and excluded
    from `gateway-api`. That makes it the one path guaranteed to work, so a
    client can always get far enough in to be told what is wrong. A compat
    check must not depend on the thing whose compatibility is in question.
    """

    server: ServerDeclaration


# ── References ──────────────────────────────────────────────────────────────


class ReferenceDetail(BaseModel):
    id: str
    owner_id: str
    owner_name: str | None = None
    read_visibility: str
    write_visibility: str
    type: str
    name: str
    description: str
    instructions: str
    value: dict[str, Any]
    attached_rooms_count: int = 0
    packages: list[str] = []
    created_at: str


class ReferenceCreateRequest(BaseModel):
    read_visibility: str = "private"
    write_visibility: str = "private"
    type: str
    name: str
    description: str
    instructions: str
    value: dict[str, Any]


class ReferenceUpdateRequest(BaseModel):
    read_visibility: str | None = None
    write_visibility: str | None = None
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    value: dict[str, Any] | None = None


class ReferenceDeleteResponse(BaseModel):
    deleted_id: str
    detached_room_ids: list[str]
    affected_package_ids: list[str] = []


class ReferenceTypeInfo(BaseModel):
    type: str
    display_name: str
    instructions: str
    value_schema: dict[str, Any]


class ResourceRoom(BaseModel):
    room_id: str
    room_name: str


# ── Linked rooms ───────────────────────────────────────────────────────────


class LinkedRoomDetail(BaseModel):
    target_room_id: str
    target_room_name: str
    target_room_description: str
    label: str


class InboundLinkedRoomDetail(BaseModel):
    source_room_id: str
    source_room_name: str
    source_room_description: str
    label: str


class LinkedRoomCreateRequest(BaseModel):
    target_room_id: str
    label: str


class RoomGraphNode(BaseModel):
    id: str
    name: str
    description: str
    # The group this room is directly assigned to, or null if standalone.
    # The frontend resolves the top-level ancestor (via `groups`) for colouring.
    group_id: str | None = None


class RoomGraphLink(BaseModel):
    source_room_id: str
    target_room_id: str
    label: str


class RoomGraphGroup(BaseModel):
    # The group tree, flattened. The frontend walks `parent_group_id` up to the
    # root to colour each room by its top-level ancestor group.
    id: str
    name: str
    color: str | None
    parent_group_id: str | None


class RoomGraphResponse(BaseModel):
    rooms: list[RoomGraphNode]
    links: list[RoomGraphLink]
    groups: list[RoomGraphGroup] = []


# ── Ecosystem graph ──────────────────────────────────────────────────────────


class EcosystemNode(BaseModel):
    # `id` is unique within the graph; `kind` discriminates the node type so
    # the frontend can colour/size/route accordingly. Keep this generic — new
    # entity kinds (rooms, users, …) can be added without a new shape.
    id: str
    kind: str  # "switch" | "agent_type" | "agent" | "bridge"
    label: str
    sublabel: str = ""
    # Set on agent nodes only when the `ecosystem.show_owners` feature flag is
    # ON; otherwise omitted so the frontend "Show owners" toggle has nothing to
    # reveal.
    owner_name: str | None = None


class EcosystemEdge(BaseModel):
    source: str
    target: str


class EcosystemGraphResponse(BaseModel):
    nodes: list[EcosystemNode]
    edges: list[EcosystemEdge]
    # Reflects the `ecosystem.show_owners` server flag. False → owner data is
    # withheld and the frontend toggle is inert.
    show_owners: bool = False


# ── Documents ──────────────────────────────────────────────────────────────


class DocumentDetail(BaseModel):
    id: str
    owner_id: str | None = None
    owner_name: str | None = None
    read_visibility: str
    write_visibility: str
    name: str
    description: str
    instructions: str
    content: str
    attached_rooms_count: int = 0
    packages: list[str] = []
    scope: str = "global"  # "global" | "room"
    room_id: str | None = None
    created_by_agent_id: str | None = None
    created_by_agent_name: str | None = None
    created_at: str


class DocumentSummary(BaseModel):
    id: str
    owner_id: str | None = None
    owner_name: str | None = None
    read_visibility: str
    write_visibility: str
    name: str
    description: str
    instructions: str
    attached_rooms_count: int = 0
    packages: list[str] = []
    scope: str = "global"
    room_id: str | None = None
    created_by_agent_id: str | None = None
    created_by_agent_name: str | None = None
    created_at: str


class DocumentCreateRequest(BaseModel):
    read_visibility: str = "private"
    write_visibility: str = "private"
    name: str
    description: str
    instructions: str
    content: str


class DocumentUpdateRequest(BaseModel):
    read_visibility: str | None = None
    write_visibility: str | None = None
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    content: str | None = None


class DocumentDeleteResponse(BaseModel):
    deleted_id: str
    detached_room_ids: list[str]
    affected_package_ids: list[str] = []


# ── Packages ───────────────────────────────────────────────────────────────


class PackageDetail(BaseModel):
    id: str
    owner_id: str
    owner_name: str | None = None
    read_visibility: str
    write_visibility: str
    name: str
    description: str
    instructions: str
    references_count: int = 0
    documents_count: int = 0
    attached_rooms_count: int = 0
    created_at: str


class PackageCreateRequest(BaseModel):
    read_visibility: str = "private"
    write_visibility: str = "private"
    name: str
    description: str
    instructions: str


class PackageUpdateRequest(BaseModel):
    read_visibility: str | None = None
    write_visibility: str | None = None
    name: str | None = None
    description: str | None = None
    instructions: str | None = None


class PackageDeleteResponse(BaseModel):
    deleted_id: str
    detached_room_ids: list[str]


class PackageMemberRemoveResponse(BaseModel):
    package_id: str
    member_id: str
    affected_room_ids: list[str]
    affected_room_names: list[str]
