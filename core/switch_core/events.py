from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class SwitchEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    # The `messages` row this event was parsed from: its `seq` in the room and
    # its event id. Whoever parses the event off its row fills both
    # (`Consumer` as it dispatches the event, the router as it decides it),
    # and the agent's own event is stored with them so a reader can match it
    # to the room row. They are not part of the
    # event's content, and stay 0 and None for an event that did not come from
    # a `messages` row.
    room_seq: int = 0
    source_event_id: str | None = None


# ── Command ───────────────────────────────────────────────────────────────────

# The `messages` row type a command is written as.
COMMAND_EVENT_TYPE = "com.switch.command"


class CommandEvent(SwitchEvent):
    command: str
    # Raw text after the `!command` token. Agents check `@{their-name}` against
    # this to decide whether they were addressed; an empty/no-`@` args means
    # the command was untargeted (every agent responds).
    args: str = ""
    user_id: str
    user_name: str
    # Event id of this command message itself — identifies the command, so two
    # commands in one thread stay distinct. Populated at dispatch (the id is not
    # part of the event content). None for synthetic/legacy events that carry no
    # id.
    message_id: str | None = None
    # Thread root that command results reply into, so each command and its
    # output stay together: the root of the thread the command was typed in, or
    # the command's own event id when it roots its own thread. Populated at
    # dispatch. None for synthetic/legacy events that carry no id.
    thread_id: str | None = None


# ── Event reporting ───────────────────────────────────────────────────────────


class ToolCallReport(SwitchEvent):
    agent_id: str
    tool_id: str
    args: dict[str, object]
    result: object
    task_id: str | None = None
    duration_ms: int | None = None
    cost: float | None = None


class LlmCallReport(SwitchEvent):
    agent_id: str
    model_id: str
    messages: list[dict[str, object]]
    response: object
    task_id: str | None = None
    usage: dict[str, object] | None = None
    duration_ms: int | None = None
    cost: float | None = None


# ── Agent runtime state ───────────────────────────────────────────────────────


class AgentRuntimeStateEvent(SwitchEvent):
    agent_id: str
    agent_name: str
    room_id: str
    # "working" | "awaiting-input" | "idle"
    state: str
    # The agent owner's account on the platform this room is bridged to, for
    # @-mentioning them when the state is "awaiting-input" (CHOO-2137). None
    # when the agent has no owner or that owner has claimed no account here —
    # the bridge says so rather than posting a nudge that reaches nobody.
    mention_handle: str | None = None
    thread_id: str | None = None
    # A `switchdash://session?…` deeplink the reporting client (Switch Console)
    # built so the bridged message can link back to its session. Relayed as-is;
    # switch-core does not construct it. None for clients that don't supply one.
    deeplink_url: str | None = None
    # A short activity line for the running turn (e.g. "Editing foo.py"). The
    # reporting client decides wording/granularity; the bridge surfaces it in
    # place on the live working message. Transient — never persisted. Only
    # meaningful while `state == "working"`; None → generic "working on it…".
    detail: str | None = None
    # Event id of the most recent message the agent has actually been handed.
    # The bridge moves the runtime indicator below the conversation when this
    # changes, so the indicator only claims the agent has seen a message once
    # the agent really has. Unchanged between reports (e.g. the periodic
    # activity refresh) means the indicator stays where it is.
    anchor_event_id: str | None = None
