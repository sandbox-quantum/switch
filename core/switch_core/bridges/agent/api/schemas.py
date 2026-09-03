from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AgentStatus,
    IntegrationProfile,
    LlmCallReport,
    ModelSpec,
    ToolCallReport,
    ToolSpec,
)

# ── Registration ──────────────────────────────────────────────────────────────


class RegisterAgentRequest(BaseModel):
    name: str
    description: str
    icon_url: str | None = None
    display_name: str | None = None
    connector_type: str
    integration_profile: IntegrationProfile
    tools: list[ToolSpec] = []
    models: list[ModelSpec] = []
    metadata: dict[str, Any] = {}
    overwrite: bool = False


class RegisterAgentResponse(BaseModel):
    id: str
    api_key: str


class RegisterKnownAgentRequest(BaseModel):
    agent_type: str
    name: str
    description: str
    icon_url: str | None = None
    display_name: str | None = None
    options: dict[str, Any] = {}
    # When set, register this agent as a child of `parent_agent_id` (e.g. a
    # Claude Code subagent under the user's main agent). None = top-level.
    parent_agent_id: str | None = None
    overwrite: bool = False


class BulkSubagentSpec(BaseModel):
    """One Claude Code subagent to register under a parent agent.

    `subagent_name` is the bare Claude Code subagent identifier (the `name`
    frontmatter field, used for the `--agent <name>` launch flag); the Switch
    agent name is derived server-side as `<parent-name>.<subagent_name>`.
    """

    subagent_name: str
    description: str


class RegisterKnownAgentBulkRequest(BaseModel):
    """Register many subagents under one parent agent in a single call.

    `options` is the shared base (e.g. `channels_enabled`, `repo_dir`) applied
    to every subagent; the per-subagent `subagent_name`
    is merged in on top. Used by the configure skill to bring a user's
    existing `.claude/agents/*.md` subagents into Switch in one step.
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


class RegisterKnownAgentBulkResponse(BaseModel):
    results: list[BulkRegisterResult]


class UpdateAgentRequest(BaseModel):
    description: str | None = None
    integration_profile: IntegrationProfile | None = None
    metadata: dict[str, Any] | None = None


# ── Messages ──────────────────────────────────────────────────────────────────


class SendMessageRequest(BaseModel):
    room_id: str
    content: str
    metadata: dict[str, Any] = {}


class TypingRequest(BaseModel):
    room_id: str
    is_typing: bool


class ConnectionRenewRequest(BaseModel):
    room_id: str


class ConnectionSubscribeRequest(BaseModel):
    """Claim (or release) a room on an open connection (CHOO-1857)."""

    connection_id: str
    room_id: str
    # Evict whichever connection currently holds the room. Off by default: the
    # usual cause of a collision is a stale process, and rejecting surfaces it.
    takeover: bool = False


class ConnectionBeatRequest(BaseModel):
    """The single client tick that keeps a connection alive (CHOO-1857).

    Replaces /connection/renew, /watch/heartbeat and /leases/renew: it proves
    the client is alive *and* consuming, and reports how far it has read so the
    event buffer knows what has been seen.
    """

    connection_id: str
    cursor: int = 0


class StatusRequest(BaseModel):
    room_id: str
    presence: Literal["online", "offline"] | None = None
    status: str | None = None
    detail: str | None = None


class RuntimeStateRequest(BaseModel):
    room_id: str
    # The canonical runtime state. Connectors map provider-specific states onto
    # these (e.g. completed → idle, error → awaiting-input) before reporting.
    state: Literal["working", "awaiting-input", "idle"]
    # Message id (`thread_id`) of the addressed message that kicked off this
    # turn, when it was in a thread, so the bridge surfaces the state in that
    # thread. Omit / null when the agent was addressed at the conversation root.
    thread_id: str | None = None
    # Message id of the latest message the connector has actually delivered to
    # the agent's session. The bridge repositions the runtime indicator when
    # this changes, so it only ever moves on evidence the agent has the
    # message — not merely because one arrived. Report the same value on a
    # periodic refresh; only a genuine change moves the indicator.
    anchor_event_id: str | None = None
    # A `switchdash://session?…` deeplink Switch Console builds so the bridged
    # working / awaiting-input message can link back to its session. Relayed
    # verbatim to the channel; null for connectors that don't manage a UI.
    deeplink_url: str | None = None
    # A short, human-readable line describing what the agent is doing right now
    # (e.g. "Editing room-connection.ts", "Running git push"). The connector
    # (Switch Console) decides granularity and wording; the bridge surfaces it in
    # place on the live "working on it…" message. Only meaningful while
    # `state == "working"`; null falls back to the generic "working on it…".
    detail: str | None = None
    # Which session-control commands this managed session can execute, e.g.
    # {"reset": true, "compact": true, "interrupt": true}. Reported by
    # Switch Console for sessions it controls; null for connectors that can't be
    # controlled (a session_dependent command then resolves to unsupported).
    control_capabilities: dict[str, bool] | None = None


# ── Resources ─────────────────────────────────────────────────────────────────


class AddToolRequest(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] | None = None


class AddToolResponse(BaseModel):
    id: str
    name: str
    agent_id: str


class AddModelRequest(BaseModel):
    name: str
    description: str


class AddModelResponse(BaseModel):
    id: str
    name: str
    agent_id: str


# ── Events ────────────────────────────────────────────────────────────────────


class EventResponse(BaseModel):
    events: list[AgentEvent]


class HistoryMessage(BaseModel):
    sender: str
    sender_name: str
    body: str
    timestamp: int | None = None


class HistoryResponse(BaseModel):
    events: list[HistoryMessage]
    has_more: bool


# ── Participants ──────────────────────────────────────────────────────────────


class ParticipantInfo(BaseModel):
    type: Literal["agent", "user"]
    agent_id: str | None = None
    name: str
    status: AgentStatus | None = None


class ParticipantsResponse(BaseModel):
    participants: list[ParticipantInfo]


# ── Mediation ────────────────────────────────────────────────────────────────


class PreToolCallRequest(BaseModel):
    room_id: str
    tool_name: str
    arguments: dict[str, Any]
    request_id: str


class PreToolCallResponse(BaseModel):
    verdict: Literal["proceed", "blocked", "modified"]
    reason: str | None = None
    modified_arguments: dict[str, Any] | None = None


class PreLlmRequestRequest(BaseModel):
    room_id: str
    model: str
    messages: list[dict[str, Any]]
    request_id: str


class PreLlmRequestResponse(BaseModel):
    verdict: Literal["proceed", "blocked", "modified"]
    reason: str | None = None
    modified_messages: list[dict[str, Any]] | None = None


class PostToolResultRequest(BaseModel):
    room_id: str
    tool_name: str
    result: Any
    request_id: str


class PostToolResultResponse(BaseModel):
    verdict: Literal["ok", "blocked", "redacted"]
    reason: str | None = None
    result: Any | None = None


class PostLlmResponseRequest(BaseModel):
    room_id: str
    model: str
    response: Any
    usage: dict[str, Any] | None = None
    request_id: str


class PostLlmResponseResponse(BaseModel):
    verdict: Literal["ok", "blocked", "redacted"]
    reason: str | None = None
    result: Any | None = None


# ── Reporting ────────────────────────────────────────────────────────────────


class ReportEventsRequest(BaseModel):
    room_id: str
    events: list[ToolCallReport | LlmCallReport]


# ── Tasks ────────────────────────────────────────────────────────────────────


class DelegateTaskRequest(BaseModel):
    room_id: str
    performer_agent_id: str
    summary: str
    description: str


class AcceptTaskRequest(BaseModel):
    task_id: str


class UpdateTaskRequest(BaseModel):
    task_id: str
    update: str


class FinaliseTaskRequest(BaseModel):
    task_id: str
    outcome: str


class CancelTaskRequest(BaseModel):
    task_id: str
    reason: str


class TaskInfo(BaseModel):
    id: str
    room_id: str
    requester_agent_id: str
    performer_agent_id: str
    summary: str
    description: str
    status: str
    updates: list[str]
    outcome: str | None = None
    created_at: str
    accepted_at: str | None = None
    finalised_at: str | None = None


class TaskListResponse(BaseModel):
    tasks: list[TaskInfo]


class DelegateTaskResponse(BaseModel):
    task: TaskInfo
    target_status: AgentStatus


class AgentInfo(BaseModel):
    id: str
    name: str
    description: str
    display_name: str | None


class TaskAgentsResponse(BaseModel):
    agents: list[AgentInfo]


# ── Moderation ───────────────────────────────────────────────────────────────


class LinkedRoomCreateSpec(BaseModel):
    target_room_id: str
    label: str


class CreateModerationRoomRequest(BaseModel):
    name: str
    description: str
    agent_names: list[str]
    # Per-agent opt-in: names (subset of agent_names) whose subagents to also add.
    include_subagents_for: list[str] | None = None
    user_names: list[str] | None = None
    channel_type: Literal["channel_public", "channel_private"] | None = None
    # Bridge is optional — omit to use the instance's default bridge.
    bridge_id: str | None = None
    # Opt out of the instance default bridge: create a room with no external
    # channel. Ignored when bridge_id is set.
    internal_only: bool = False
    admin_mode: bool = False
    security_config: dict[str, Any] | None = None
    instructions: str | None = None
    reference_ids: list[str] | None = None
    package_ids: list[str] | None = None
    linked_rooms: list[LinkedRoomCreateSpec] | None = None


class CreateModerationRoomResponse(BaseModel):
    id: str
    name: str
    matrix_room_id: str
    # Attachments that failed at attach-time (after the room was created).
    # Empty on full success.
    failed_attachments: list[dict[str, Any]] = []


class ListBridgesResponse(BaseModel):
    bridges: list[dict[str, Any]]


class InviteAgentRequest(BaseModel):
    agent_name: str
    # When true, also add the invited agent's subagents (child agents).
    include_subagents: bool = False


class UpdateSecurityRequest(BaseModel):
    checks: list[dict[str, Any]]


class RoomInfo(BaseModel):
    id: str
    name: str
    description: str


class RoomDetailResponse(BaseModel):
    id: str
    name: str
    description: str
    channel_type: str | None
    admin_mode: bool
    agent_names: list[str]


class RoomListResponse(BaseModel):
    rooms: list[RoomInfo]


class AgentListResponse(BaseModel):
    agents: list[AgentInfo]


class SetFeatureFlagRequest(BaseModel):
    enabled: bool


class FeatureFlagInfo(BaseModel):
    key: str
    enabled: bool


class FeatureFlagListResponse(BaseModel):
    flags: list[FeatureFlagInfo]
