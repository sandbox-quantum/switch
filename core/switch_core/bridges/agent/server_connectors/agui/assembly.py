"""Reduce a stream of AG-UI events into the things a room actually needs.

Two jobs, both of which are where AG-UI's sharp edges live.

**Assembly.** Text and tool calls arrive as deltas in one of two mutually
exclusive shapes — the ``*_START``/``*_CONTENT``/``*_END`` triad, or the
``*_CHUNK`` variant that bypasses it with every field optional. Producers pick
one; a consumer that implements only the triad loses every word a chunk-based
producer sends, with no error anywhere. Both are handled here.

**Termination.** A stream that stops without ``RUN_FINISHED`` or ``RUN_ERROR``
— a dropped socket, a proxy timeout, an evicted pod — is reported by AG-UI's
own client as a *successful* run carrying whatever partial text had arrived.
This assembler refuses to do that: ``finish()`` raises unless a terminator was
seen. A half-delivered answer must never reach a room looking whole.

Assembly is deliberately free of I/O so that all of this is directly testable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from switch_core.bridges.agent.server_connectors.agui.events import (
    ActivityDelta,
    ActivitySnapshot,
    AgUiEvent,
    AgUiProtocolError,
    MessagesSnapshot,
    RunError,
    RunFinished,
    StateDelta,
    StateSnapshot,
    StepFinished,
    StepStarted,
    TextMessageChunk,
    TextMessageContent,
    TextMessageEnd,
    TextMessageStart,
    ToolCallArgs,
    ToolCallChunk,
    ToolCallEnd,
    ToolCallResult,
    ToolCallStart,
)


class IncompleteRunError(AgUiProtocolError):
    """The stream ended without a terminator, so the run's outcome is unknown."""


class RunFailedError(AgUiProtocolError):
    """The agent reported `RUN_ERROR`."""

    def __init__(self, message: str, code: str | None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TextOutput:
    """A complete assistant message, ready to post as one room message."""

    message_id: str
    role: str
    content: str


@dataclass(frozen=True)
class ToolCallOutput:
    """A complete tool call for Switch to execute."""

    tool_call_id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class StatusOutput:
    """Transient progress, for the room's status line rather than its history."""

    detail: str


@dataclass(frozen=True)
class AgentToolResult:
    """A result for a tool the agent ran itself. Recorded, never executed."""

    tool_call_id: str
    content: str


@dataclass(frozen=True)
class StateOutput:
    """A state snapshot, or an RFC 6902 patch to be validated before applying."""

    snapshot: Any = None
    delta: list[dict[str, Any]] | None = None


RunOutput = TextOutput | ToolCallOutput | StatusOutput | AgentToolResult | StateOutput


@dataclass
class _OpenText:
    message_id: str
    role: str
    parts: list[str] = field(default_factory=list)


@dataclass
class _OpenToolCall:
    tool_call_id: str
    name: str
    parts: list[str] = field(default_factory=list)


class RunAssembler:
    """Feed events in order; take outputs as they complete.

    Unhandled event types are ignored rather than rejected, which is what makes
    the connector survive an AG-UI release that adds events. Malformed events
    never reach here — `parse_event` has already refused them.
    """

    def __init__(self) -> None:
        self._text: _OpenText | None = None
        self._tool_calls: dict[str, _OpenToolCall] = {}
        self._tool_order: list[str] = []
        self._terminated = False
        self._error: RunError | None = None

    def feed(self, event: AgUiEvent) -> list[RunOutput]:
        if self._terminated:
            raise AgUiProtocolError(
                f"AG-UI event {event.type!r} arrived after the run terminated"
            )

        if isinstance(event, TextMessageStart):
            return self._open_text(event.message_id, event.role)
        if isinstance(event, TextMessageContent):
            self._append_text(event.message_id, event.delta)
            return []
        if isinstance(event, TextMessageEnd):
            return self._close_text()
        if isinstance(event, TextMessageChunk):
            return self._feed_text_chunk(event)

        if isinstance(event, ToolCallStart):
            self._open_tool_call(event.tool_call_id, event.tool_call_name)
            return []
        if isinstance(event, ToolCallArgs):
            self._append_tool_args(event.tool_call_id, event.delta)
            return []
        if isinstance(event, ToolCallEnd):
            return self._close_tool_call(event.tool_call_id)
        if isinstance(event, ToolCallChunk):
            return self._feed_tool_chunk(event)

        if isinstance(event, ToolCallResult):
            return [
                AgentToolResult(tool_call_id=event.tool_call_id, content=event.content)
            ]

        if isinstance(event, StepStarted):
            return [StatusOutput(detail=event.step_name)]
        if isinstance(event, StepFinished):
            return []
        if isinstance(event, (ActivitySnapshot, ActivityDelta)):
            return [StatusOutput(detail=event.description)] if event.description else []

        if isinstance(event, StateSnapshot):
            return [StateOutput(snapshot=event.snapshot)]
        if isinstance(event, StateDelta):
            return [StateOutput(delta=event.delta)]
        if isinstance(event, MessagesSnapshot):
            return []

        if isinstance(event, RunFinished):
            self._terminated = True
            return self._drain()
        if isinstance(event, RunError):
            self._terminated = True
            self._error = event
            return []

        return []

    def finish(self) -> None:
        """Assert the run ended properly. Raises if it did not.

        This is the check that stops a truncated stream being mistaken for a
        completed one, so it is called on every run, including ones that
        produced plenty of output.
        """
        if self._error is not None:
            raise RunFailedError(self._error.message, self._error.code)
        if not self._terminated:
            raise IncompleteRunError(
                "AG-UI stream ended without RUN_FINISHED or RUN_ERROR; "
                "the run's output may be incomplete"
            )

    def _open_text(self, message_id: str, role: str) -> list[RunOutput]:
        outputs = self._close_text()
        self._text = _OpenText(message_id=message_id, role=role)
        return outputs

    def _append_text(self, message_id: str, delta: str) -> None:
        if self._text is None:
            self._text = _OpenText(message_id=message_id, role="assistant")
        self._text.parts.append(delta)

    def _close_text(self) -> list[RunOutput]:
        if self._text is None:
            return []
        open_text, self._text = self._text, None
        content = "".join(open_text.parts)
        if not content:
            return []
        return [
            TextOutput(
                message_id=open_text.message_id,
                role=open_text.role,
                content=content,
            )
        ]

    def _feed_text_chunk(self, event: TextMessageChunk) -> list[RunOutput]:
        outputs: list[RunOutput] = []
        starts_new = event.message_id is not None and (
            self._text is None or self._text.message_id != event.message_id
        )
        if starts_new:
            outputs = self._close_text()
            self._text = _OpenText(
                message_id=event.message_id or "",
                role=event.role or "assistant",
            )
        if event.delta:
            if self._text is None:
                self._text = _OpenText(message_id="", role=event.role or "assistant")
            self._text.parts.append(event.delta)
        return outputs

    def _open_tool_call(self, tool_call_id: str, name: str) -> None:
        if tool_call_id not in self._tool_calls:
            self._tool_order.append(tool_call_id)
        self._tool_calls[tool_call_id] = _OpenToolCall(
            tool_call_id=tool_call_id, name=name
        )

    def _append_tool_args(self, tool_call_id: str, delta: str) -> None:
        call = self._tool_calls.get(tool_call_id)
        if call is None:
            raise AgUiProtocolError(
                f"AG-UI sent arguments for unknown tool call {tool_call_id!r}"
            )
        call.parts.append(delta)

    def _close_tool_call(self, tool_call_id: str) -> list[RunOutput]:
        call = self._tool_calls.pop(tool_call_id, None)
        if call is None:
            raise AgUiProtocolError(f"AG-UI ended unknown tool call {tool_call_id!r}")
        if tool_call_id in self._tool_order:
            self._tool_order.remove(tool_call_id)
        return [
            ToolCallOutput(
                tool_call_id=call.tool_call_id,
                name=call.name,
                arguments="".join(call.parts),
            )
        ]

    def _feed_tool_chunk(self, event: ToolCallChunk) -> list[RunOutput]:
        if event.tool_call_id is not None and event.tool_call_name is not None:
            self._open_tool_call(event.tool_call_id, event.tool_call_name)

        if not event.delta:
            return []

        target = event.tool_call_id or (
            self._tool_order[-1] if self._tool_order else None
        )
        if target is None:
            raise AgUiProtocolError(
                "AG-UI sent tool-call arguments before naming a tool call"
            )
        self._append_tool_args(target, event.delta)
        return []

    def _drain(self) -> list[RunOutput]:
        """Close whatever the run left open.

        Chunk-shaped output has no explicit terminator, so a message or tool
        call is routinely still open when the run finishes. Dropping it would
        lose the entire reply from a chunk-based producer.
        """
        outputs = self._close_text()
        for tool_call_id in list(self._tool_order):
            outputs.extend(self._close_tool_call(tool_call_id))
        return outputs
