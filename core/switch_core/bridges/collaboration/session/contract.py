"""Session interaction wire contract, version 1.

A Python mirror of `console/packages/shared/src/session-v1/contract.ts` and its
zod schemas in `validation.ts`. The TypeScript side is the original; this is a
second reading of the same wire format for the half of Switch that is written
in Python, and the two only stay in step deliberately. A divergence does not
fail on either side of the wire on its own — it just renders the wrong thing,
or rejects a message the other end considers valid.

`test_session_contract_parity.py` reads the same `examples.json` as
`session-v1.test.ts` and asserts the shapes that test asserts, so the pair fails
loudly when one moves.

Field names on the wire are camelCase; the models accept and emit those, and
expose snake_case attributes. Dump with `by_alias=True`.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
)
from pydantic.alias_generators import to_camel

# The contract is carried by JSON, so a counter has to survive a double. The
# TypeScript side bounds every counter by Number.MAX_SAFE_INTEGER; a Python int
# does not overflow there, which is exactly why the bound has to be explicit.
MAX_SAFE_INTEGER = 9007199254740991

# `parseHostEvent` refuses anything larger. Hosts split before they send.
MAX_EVENT_BYTES = 64 * 1024


def _iso_datetime(value: str) -> str:
    """Reject a timestamp zod's `z.iso.datetime()` would reject."""
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"not an ISO-8601 timestamp: {value!r}") from error
    return value


Id = Annotated[str, StringConstraints(min_length=1)]
Counter = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
Sequence = Annotated[int, Field(ge=1, le=MAX_SAFE_INTEGER)]
Timestamp = Annotated[str, AfterValidator(_iso_datetime)]

Surface = Literal[
    "console",
    "switch-web",
    "slack",
    "mattermost",
    "discord",
    "teams",
    "telegram",
]
Provider = Literal["claude", "codex", "opencode", "gemini", "cursor"]


class _Model(BaseModel):
    """Every contract type: camelCase on the wire, unknown keys refused.

    Refusing unknown keys is the point rather than a default. The contract
    carries no provider-native payload, and a bridge that silently forwarded one
    would publish whatever a host chose to attach into a room.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
        protected_namespaces=(),
    )


class Origin(_Model):
    """Who acted, and where. The server sets this from a verified identity."""

    surface: Surface
    actor_id: Id
    room_id: Id | None
    thread_id: Id | None
    message_id: Id | None


class Capability(_Model):
    input: Literal["queue", "steer"]
    approvals: bool
    questions: bool
    interrupt: bool
    reset: bool
    compact: bool
    model_change: bool
    attachment_mime_types: list[str]


class Attachment(_Model):
    attachment_id: Id
    name: str
    mime_type: str
    bytes: Counter


class Item(_Model):
    item_id: Id
    turn_id: Id
    revision: Counter
    kind: Literal["user-message", "assistant-message", "tool-activity"]
    status: Literal["in-progress", "completed", "failed", "declined"]
    title: str
    text: str
    attachments: list[Attachment]
    origin: Origin | None


class ApprovalOption(_Model):
    option_id: Id
    label: str
    decision: Literal["accept", "acceptForSession", "decline", "cancel"]


class QuestionOption(_Model):
    option_id: Id
    label: str
    description: str | None


class Question(_Model):
    question_id: Id
    title: str
    prompt: str
    options: list[QuestionOption]
    multi_select: bool
    allow_custom_answer: bool


class Answer(_Model):
    question_id: Id
    selected_option_ids: list[Id]
    custom_text: str | None


class ApprovalResult(_Model):
    kind: Literal["approval"]
    option_id: Id


class QuestionsResult(_Model):
    kind: Literal["questions"]
    answers: list[Answer]


RequestResult = Annotated[
    ApprovalResult | QuestionsResult,
    Field(discriminator="kind"),
]


class ApprovalContent(_Model):
    kind: Literal["approval"]
    title: str
    detail: str | None
    options: list[ApprovalOption]


class QuestionsContent(_Model):
    kind: Literal["questions"]
    title: str
    questions: list[Question]


RequestContent = Annotated[
    ApprovalContent | QuestionsContent,
    Field(discriminator="kind"),
]


class Request(_Model):
    request_id: Id
    turn_id: Id
    revision: Counter
    state: Literal["open", "submitting", "resolved", "closed"]
    content: RequestContent
    expires_at: Timestamp | None


class Session(_Model):
    session_id: Id
    agent_id: Id
    provider: Provider
    host_id: Id
    epoch: Id
    status: Literal["starting", "ready", "running", "stopped", "error"]
    connectivity: Literal["online", "offline"]
    capabilities: Capability
    pending_request_ids: list[Id]


# ── Event bodies ─────────────────────────────────────────────────────────────


class SessionUpsert(_Model):
    type: Literal["session.upsert"]
    session: Session


class TurnUpsert(_Model):
    type: Literal["turn.upsert"]
    turn_id: Id
    status: Literal["queued", "running", "completed", "interrupted", "error"]
    command_id: Id | None


class ItemUpsert(_Model):
    type: Literal["item.upsert"]
    item: Item


class RequestOpened(_Model):
    type: Literal["request.opened"]
    request: Request


class RequestSettled(_Model):
    type: Literal["request.settled"]
    request_id: Id
    revision: Counter
    outcome: Literal[
        "answered", "cancelled", "expired", "interrupted", "provider-error"
    ]
    command_id: Id | None
    result: RequestResult | None


class CommandResult(_Model):
    type: Literal["command.result"]
    command_id: Id
    status: Literal["applied", "rejected", "unknown"]
    code: str | None
    message: str | None


class Notice(_Model):
    type: Literal["notice"]
    level: Literal["info", "warning", "error"]
    code: Id
    message: str


class CommandStatus(_Model):
    type: Literal["command.status"]
    command_id: Id
    status: Literal["accepted", "dispatched", "applied", "rejected", "unknown"]
    code: str | None
    message: str | None


class RequestSubmitting(_Model):
    type: Literal["request.submitting"]
    request_id: Id
    revision: Counter
    command_id: Id
    actor_id: Id
    surface: Surface


class SessionConnectivity(_Model):
    type: Literal["session.connectivity"]
    connectivity: Literal["online", "offline"]


_HostBodies = (
    SessionUpsert
    | TurnUpsert
    | ItemUpsert
    | RequestOpened
    | RequestSettled
    | CommandResult
    | Notice
)

HostBody = Annotated[_HostBodies, Field(discriminator="type")]

ServerBody = Annotated[
    _HostBodies | CommandStatus | RequestSubmitting | SessionConnectivity,
    Field(discriminator="type"),
]


class HostEvent(_Model):
    contract_version: Literal[1]
    event_id: Id
    session_id: Id
    epoch: Id
    host_sequence: Sequence
    occurred_at: Timestamp
    body: HostBody


class ServerEvent(_Model):
    contract_version: Literal[1]
    event_id: Id
    session_id: Id
    sequence: Sequence
    occurred_at: Timestamp
    body: ServerBody


# ── Commands ─────────────────────────────────────────────────────────────────


class MessageSend(_Model):
    type: Literal["message.send"]
    text: str
    attachments: list[Attachment]
    delivery: Literal["queue", "steer"]


class RequestAnswer(_Model):
    type: Literal["request.answer"]
    request_id: Id
    expected_revision: Counter
    answer: RequestResult


class TurnInterrupt(_Model):
    type: Literal["turn.interrupt"]
    turn_id: Id


class SessionStop(_Model):
    type: Literal["session.stop"]


class SessionReset(_Model):
    type: Literal["session.reset"]


class SessionCompact(_Model):
    type: Literal["session.compact"]


class SessionModelSet(_Model):
    type: Literal["session.model.set"]
    model_id: Id
    options: dict[str, str]


CommandBody = Annotated[
    MessageSend
    | RequestAnswer
    | TurnInterrupt
    | SessionStop
    | SessionReset
    | SessionCompact
    | SessionModelSet,
    Field(discriminator="type"),
]


class Command(_Model):
    """The server sets origin from a verified identity. A client body has none."""

    contract_version: Literal[1]
    command_id: Id
    session_id: Id
    epoch: Id
    origin: Origin
    body: CommandBody


# ── Snapshot ─────────────────────────────────────────────────────────────────


class DecidedBy(_Model):
    actor_id: Id
    surface: Surface
    command_id: Id


class SnapshotRequest(Request):
    """A request as the snapshot carries it: with how, and by whom, it settled."""

    result: RequestSettled | None
    decided_by: DecidedBy | None


class Snapshot(_Model):
    contract_version: Literal[1]
    through_sequence: Counter
    session: Session
    turns: list[TurnUpsert]
    items: list[Item]
    requests: list[SnapshotRequest]
    command_statuses: list[CommandStatus]
    next_page_token: str | None


# ── Parsing ──────────────────────────────────────────────────────────────────


def event_bytes(event: Any) -> int:
    """The size the host measured.

    The host counts `TextEncoder().encode(JSON.stringify(event)).byteLength`, so
    both of `json.dumps`'s defaults have to go: it pads every separator, and it
    escapes anything non-ASCII, which makes an emoji twelve bytes here and four
    on the host. Either one alone reads a compliant event as oversized.
    """
    return len(
        json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )


def parse_host_event(payload: Any) -> HostEvent:
    """Read a host event, refusing one no host should have sent."""
    if event_bytes(payload) > MAX_EVENT_BYTES:
        raise ValueError("PAYLOAD_TOO_LARGE: event exceeds 64 KiB.")
    event = HostEvent.model_validate(payload)
    body = event.body
    if isinstance(body, SessionUpsert) and (
        body.session.session_id != event.session_id or body.session.epoch != event.epoch
    ):
        raise ValueError("Session identity does not match event envelope.")
    return event


def parse_server_event(payload: Any) -> ServerEvent:
    return ServerEvent.model_validate(payload)


def parse_snapshot(payload: Any) -> Snapshot:
    return Snapshot.model_validate(payload)


def parse_command(payload: Any) -> Command:
    return Command.model_validate(payload)
