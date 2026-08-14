"""AG-UI protocol events, as Switch consumes them.

Hand-rolled rather than taken from a library. There is no Python AG-UI client
on PyPI — the published `ag-ui-protocol` package ships the pieces for building
AG-UI *servers* — and the wire carries no protocol version, so nothing can tell
us at runtime what a peer speaks. Declaring the shapes here makes the version
we assume explicit and keeps a pre-1.0 dependency out of `core`.

Two rules govern the parsing, and they pull in opposite directions on purpose:

- **Unknown event types are not an error.** AG-UI ships breaking changes
  without a changelog, so an event we have never heard of is returned as a
  plain `AgUiEvent` and ignored downstream rather than failing the run.
- **Malformed events are an error.** A frame that is not an object, carries no
  `type`, or omits a field the event cannot mean anything without, is raised
  rather than skipped. Forward compatibility is not a reason to accept
  corruption.

Fields Switch does not read are preserved rather than dropped (`extra="allow"`)
so a future consumer can reach them without a parser change.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class AgUiProtocolError(Exception):
    """Base for every AG-UI wire-level failure."""


class MalformedEventError(AgUiProtocolError):
    """An event that cannot be interpreted, as opposed to one we do not know."""


class EventType(StrEnum):
    """The 33 event types AG-UI defines, as of `@ag-ui/core` 0.0.57.

    Listed in full — including the ones Switch ignores — so that "we do not
    handle this" is visibly different from "we have never heard of this".
    """

    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"

    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"

    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK"
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"

    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"

    ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT"
    ACTIVITY_DELTA = "ACTIVITY_DELTA"

    RAW = "RAW"
    CUSTOM = "CUSTOM"

    REASONING_START = "REASONING_START"
    REASONING_END = "REASONING_END"
    REASONING_ENCRYPTED_VALUE = "REASONING_ENCRYPTED_VALUE"
    REASONING_MESSAGE_START = "REASONING_MESSAGE_START"
    REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT"
    REASONING_MESSAGE_END = "REASONING_MESSAGE_END"
    REASONING_MESSAGE_CHUNK = "REASONING_MESSAGE_CHUNK"


DEPRECATED_ALIASES: dict[str, EventType] = {
    "THINKING_START": EventType.REASONING_START,
    "THINKING_END": EventType.REASONING_END,
    "THINKING_TEXT_MESSAGE_START": EventType.REASONING_MESSAGE_START,
    "THINKING_TEXT_MESSAGE_CONTENT": EventType.REASONING_MESSAGE_CONTENT,
    "THINKING_TEXT_MESSAGE_END": EventType.REASONING_MESSAGE_END,
}
"""`THINKING_*` was renamed to `REASONING_*` in 0.0.45 and is slated for removal
in 1.0. Producers pinned to an older version still emit the old names, so they
are normalised on the way in and never appear downstream."""


class AgUiEvent(BaseModel):
    """Any AG-UI event, including one whose type we do not recognise."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    type: str
    timestamp: int | None = None


class RunStarted(AgUiEvent):
    type: str = EventType.RUN_STARTED

    thread_id: str | None = Field(default=None, alias="threadId")
    run_id: str | None = Field(default=None, alias="runId")


class RunFinished(AgUiEvent):
    type: str = EventType.RUN_FINISHED

    thread_id: str | None = Field(default=None, alias="threadId")
    run_id: str | None = Field(default=None, alias="runId")
    result: Any = None
    outcome: dict[str, Any] | None = None


class RunError(AgUiEvent):
    type: str = EventType.RUN_ERROR

    message: str
    code: str | None = None


class StepStarted(AgUiEvent):
    type: str = EventType.STEP_STARTED

    step_name: str = Field(alias="stepName")


class StepFinished(AgUiEvent):
    type: str = EventType.STEP_FINISHED

    step_name: str = Field(alias="stepName")


class TextMessageStart(AgUiEvent):
    type: str = EventType.TEXT_MESSAGE_START

    message_id: str = Field(alias="messageId")
    role: str = "assistant"


class TextMessageContent(AgUiEvent):
    type: str = EventType.TEXT_MESSAGE_CONTENT

    message_id: str = Field(alias="messageId")
    delta: str


class TextMessageEnd(AgUiEvent):
    type: str = EventType.TEXT_MESSAGE_END

    message_id: str = Field(alias="messageId")


class TextMessageChunk(AgUiEvent):
    """The chunk shape, which bypasses the start/content/end triad entirely.

    Every field is optional by specification. A decoder that handles only the
    triad drops all content from a producer that emits chunks, silently — so
    this is not an optional event to support.
    """

    type: str = EventType.TEXT_MESSAGE_CHUNK

    message_id: str | None = Field(default=None, alias="messageId")
    role: str | None = None
    delta: str | None = None


class ToolCallStart(AgUiEvent):
    type: str = EventType.TOOL_CALL_START

    tool_call_id: str = Field(alias="toolCallId")
    tool_call_name: str = Field(alias="toolCallName")
    parent_message_id: str | None = Field(default=None, alias="parentMessageId")


class ToolCallArgs(AgUiEvent):
    type: str = EventType.TOOL_CALL_ARGS

    tool_call_id: str = Field(alias="toolCallId")
    delta: str


class ToolCallEnd(AgUiEvent):
    type: str = EventType.TOOL_CALL_END

    tool_call_id: str = Field(alias="toolCallId")


class ToolCallChunk(AgUiEvent):
    """The tool-call chunk shape. See `TextMessageChunk`."""

    type: str = EventType.TOOL_CALL_CHUNK

    tool_call_id: str | None = Field(default=None, alias="toolCallId")
    tool_call_name: str | None = Field(default=None, alias="toolCallName")
    parent_message_id: str | None = Field(default=None, alias="parentMessageId")
    delta: str | None = None


class ToolCallResult(AgUiEvent):
    """A result for a tool the *agent* executed, not one Switch was asked to."""

    type: str = EventType.TOOL_CALL_RESULT

    tool_call_id: str = Field(alias="toolCallId")
    content: str
    message_id: str | None = Field(default=None, alias="messageId")
    role: str | None = None


class StateSnapshot(AgUiEvent):
    type: str = EventType.STATE_SNAPSHOT

    snapshot: Any = None


class StateDelta(AgUiEvent):
    """An RFC 6902 patch produced by an external agent.

    The patch is carried as-is here; it is validated where it is applied, not
    where it is parsed.
    """

    type: str = EventType.STATE_DELTA

    delta: list[dict[str, Any]]


class MessagesSnapshot(AgUiEvent):
    type: str = EventType.MESSAGES_SNAPSHOT

    messages: list[dict[str, Any]]


class ActivitySnapshot(AgUiEvent):
    type: str = EventType.ACTIVITY_SNAPSHOT

    description: str | None = None


class ActivityDelta(AgUiEvent):
    type: str = EventType.ACTIVITY_DELTA

    description: str | None = None


_MODELS: dict[str, type[AgUiEvent]] = {
    EventType.RUN_STARTED: RunStarted,
    EventType.RUN_FINISHED: RunFinished,
    EventType.RUN_ERROR: RunError,
    EventType.STEP_STARTED: StepStarted,
    EventType.STEP_FINISHED: StepFinished,
    EventType.TEXT_MESSAGE_START: TextMessageStart,
    EventType.TEXT_MESSAGE_CONTENT: TextMessageContent,
    EventType.TEXT_MESSAGE_END: TextMessageEnd,
    EventType.TEXT_MESSAGE_CHUNK: TextMessageChunk,
    EventType.TOOL_CALL_START: ToolCallStart,
    EventType.TOOL_CALL_ARGS: ToolCallArgs,
    EventType.TOOL_CALL_END: ToolCallEnd,
    EventType.TOOL_CALL_CHUNK: ToolCallChunk,
    EventType.TOOL_CALL_RESULT: ToolCallResult,
    EventType.STATE_SNAPSHOT: StateSnapshot,
    EventType.STATE_DELTA: StateDelta,
    EventType.MESSAGES_SNAPSHOT: MessagesSnapshot,
    EventType.ACTIVITY_SNAPSHOT: ActivitySnapshot,
    EventType.ACTIVITY_DELTA: ActivityDelta,
}


def parse_event(payload: object) -> AgUiEvent:
    """Turn one decoded SSE frame into an event.

    An unrecognised `type` yields a plain `AgUiEvent`, which downstream ignores.
    Anything that cannot be interpreted at all raises `MalformedEventError`.
    """
    if not isinstance(payload, dict):
        raise MalformedEventError(
            f"AG-UI event must be a JSON object, got {type(payload).__name__}"
        )

    raw_type = payload.get("type")
    if not isinstance(raw_type, str) or not raw_type:
        raise MalformedEventError(f"AG-UI event has no usable 'type': {payload!r}")

    alias = DEPRECATED_ALIASES.get(raw_type)
    if alias is not None:
        payload = {**payload, "type": alias.value}
        raw_type = alias.value

    model = _MODELS.get(raw_type)
    if model is None:
        return AgUiEvent.model_validate(payload)

    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise MalformedEventError(f"malformed {raw_type} event: {exc}") from exc
