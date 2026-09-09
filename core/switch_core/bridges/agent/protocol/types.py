from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, model_validator

# ── Agent integration profile ─────────────────────────────────────────────────


class TaskProtocolConfig(BaseModel):
    can_delegate: bool
    can_accept: bool


# How an agent-type supports a session-control command (reset / compact /
# interrupt):
#   - "unsupported": the command never applies to this agent-type.
#   - "always": the agent-type can always act on it, regardless of session.
#   - "session_dependent": support depends on the specific live session — e.g.
#     a Claude Code session launched from Switch Console can be controlled, but a
#     standalone `claude` session started in a plain terminal cannot. The live
#     session declares its own capabilities via AgentRuntimeState.
CommandLevel = Literal["unsupported", "always", "session_dependent"]


class CommandCapabilities(BaseModel):
    reset: CommandLevel = "unsupported"
    compact: CommandLevel = "unsupported"
    interrupt: CommandLevel = "unsupported"


class IntegrationProfile(BaseModel):
    connection_model: Literal[
        "always_on", "session_addressable", "session_passive", "auto_session"
    ]
    message_exchange: bool
    pre_invocation_mediation: list[str]
    post_invocation_mediation: list[str]
    event_reporting: list[str]
    task_protocol: TaskProtocolConfig
    # Defaults to all-"unsupported" so integration profiles persisted before
    # this feature (which lack the key) re-validate cleanly and behave as
    # "no session-control support" until the agent is re-registered.
    command_capabilities: CommandCapabilities = CommandCapabilities()


class ToolSpec(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] | None = None


class ModelSpec(BaseModel):
    name: str
    description: str


class RegistrationResult(BaseModel):
    agent_id: str
    api_key: str
    oauth_client_id: str | None = None


# ── Reporting ─────────────────────────────────────────────────────────────────


class ToolCallReport(BaseModel):
    type: Literal["tool_call"] = "tool_call"
    tool_name: str
    arguments: dict[str, Any]
    result: Any
    request_id: str
    timestamp: str
    duration_ms: int | None = None
    cost: float | None = None


class LlmCallReport(BaseModel):
    type: Literal["llm_call"] = "llm_call"
    model: str
    messages: list[dict[str, Any]]
    response: Any
    request_id: str
    timestamp: str
    usage: dict[str, Any] | None = None
    duration_ms: int | None = None
    cost: float | None = None


class RoomDescriptor(BaseModel):
    id: str
    name: str
    description: str
    transport_room_id: str
    # Deprecated alias of `transport_room_id`, sent for the compatibility
    # window. Connectors are installed copies and only update when someone
    # clicks Update, so both names are carried until the shipped ones have
    # moved. Same value in both; nothing dereferences either.
    matrix_room_id: str
    archived: bool = False
    # The room's collaboration bridge, or None for an internal-only room.
    # Carried so a caller that already resolved the room does not have to read
    # it again to decide whether an outbound signal has anywhere to go.
    bridge_id: str | None = None


class AgentStatus(StrEnum):
    LIVE = "live"
    DISCONNECTED = "disconnected"
    AWAITING_MANUAL_POLL = "awaiting_manual_poll"
    NO_SESSION = "no_session"
    # auto_session agent with no live session for the room but a connector
    # actively watching (global "watching" heartbeat) — it will spin up a
    # session on demand when addressed.
    DORMANT = "dormant"
    # Reachable, but its addressing policy does not admit this sender, so it
    # will decline in the room rather than act. Not a connectivity state: the
    # message is still delivered and still answered, just with a refusal.
    NOT_PERMITTED = "not_permitted"


class SendTargetedResult(BaseModel):
    event_id: str
    target_statuses: dict[str, AgentStatus]


class DelegateTaskResult(BaseModel):
    task_id: str
    target_status: AgentStatus


class ParticipantDescriptor(BaseModel):
    id: str
    name: str
    type: Literal["agent", "user"]
    agent_type: str | None = None
    display_name: str | None = None
    can_delegate: bool = False
    can_accept: bool = False
    status: AgentStatus | None = None
    # The room-scoped role this agent currently (live-lease) holds, if any.
    room_role: str | None = None
    # The agent's room-scoped alias, if any: `@<alias>` addresses it in this
    # room exactly like its real name.
    alias: str | None = None


class RoomDetailDescriptor(BaseModel):
    id: str
    name: str
    description: str
    channel_type: str | None
    admin_mode: bool
    instructions: str | None
    transport_room_id: str
    # Deprecated alias of `transport_room_id`, sent for the compatibility
    # window. Connectors are installed copies and only update when someone
    # clicks Update, so both names are carried until the shipped ones have
    # moved. Same value in both; nothing dereferences either.
    matrix_room_id: str
    created_at: str
    bridge_id: str | None
    bridge_display_name: str | None
    external_channel_id: str | None
    # The group this room belongs to (navigation layer), or null if standalone.
    # `group_path` is the human-readable ancestry, e.g. "Parent / Child".
    group_id: str | None
    group_name: str | None
    group_path: str | None
    agent_names: list[str]
    agent_statuses: dict[str, str]
    connected_user_names: list[str]
    # Names of agents configured to receive `room_join` events in this room.
    join_event_listeners: list[str] = []
    # Per-room agent aliases, keyed by agent name → alias (only agents that
    # have an alias in this room appear).
    aliases: dict[str, str] = {}
    # The room's assumable roles, mirroring `list_roles`: each entry carries
    # `name`, `exclusive`, `instructions_preview`, `held_by` (holder objects
    # with presence), and `assumable_by_me`.
    roles: list[dict[str, Any]] = []
    archived: bool = False


EventType = Literal[
    "message",
    "command",
    "room_join",
    "task_delegate",
    "task_accept",
    "task_update",
    "task_finalise",
    "task_cancel",
]


class AttachmentRef(BaseModel):
    """A pointer to a media attachment on a message event.

    Carries metadata plus the Matrix `mxc://` URI only — never the bytes. The
    actual file is fetched on demand via the media-download endpoint.
    """

    filename: str
    mimetype: str
    size: int
    mxc: str
    msgtype: str


class MessagePayload(BaseModel):
    addressed: bool
    sender: str
    sender_name: str
    message_id: str
    body: str
    timestamp: int
    thread_id: str | None = None
    attachments: list[AttachmentRef] = []


class CommandPayload(BaseModel):
    command: str
    args: str = ""
    user_id: str
    user_name: str
    # Thread root of the originating command message, so a controller executing
    # the command (e.g. Switch Console on reset/compact) can have the agent post its
    # completion notice back into that same thread. None when the command was
    # not in a thread.
    thread_id: str | None = None


class RoomJoinPayload(BaseModel):
    # The joiner's matrix user id (the member event's state_key) and display
    # name. room_id / bridge_id / channel_type live on the enclosing AgentEvent.
    member: str
    member_name: str
    timestamp: int
    # Whether the receiving agent is configured to react to join events in this
    # room (per-room, per-agent). The event is delivered regardless; connectors
    # use this to decide whether to surface it.
    listening: bool


class TaskDelegatePayload(BaseModel):
    task_id: str
    requester_agent_id: str
    performer_agent_id: str
    summary: str
    description: str


class TaskAcceptPayload(BaseModel):
    task_id: str
    requester_agent_id: str
    performer_agent_id: str


class TaskUpdatePayload(BaseModel):
    task_id: str
    requester_agent_id: str
    performer_agent_id: str
    update: str


class TaskFinalisePayload(BaseModel):
    task_id: str
    requester_agent_id: str
    performer_agent_id: str
    outcome: str


class TaskCancelPayload(BaseModel):
    task_id: str
    requester_agent_id: str
    performer_agent_id: str
    reason: str


Payload = (
    MessagePayload
    | CommandPayload
    | RoomJoinPayload
    | TaskDelegatePayload
    | TaskAcceptPayload
    | TaskUpdatePayload
    | TaskFinalisePayload
    | TaskCancelPayload
)

_PAYLOAD_TYPE: dict[str, type[BaseModel]] = {
    "message": MessagePayload,
    "command": CommandPayload,
    "room_join": RoomJoinPayload,
    "task_delegate": TaskDelegatePayload,
    "task_accept": TaskAcceptPayload,
    "task_update": TaskUpdatePayload,
    "task_finalise": TaskFinalisePayload,
    "task_cancel": TaskCancelPayload,
}


class AgentEvent(BaseModel):
    type: EventType
    room_id: str
    bridge_id: str | None = None
    channel_type: str | None = None
    payload: Payload

    @model_validator(mode="before")
    @classmethod
    def _parse_payload(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("payload"), dict):
            payload_cls = _PAYLOAD_TYPE.get(data.get("type", ""))
            if payload_cls:
                data["payload"] = payload_cls.model_validate(data["payload"])
        return data
