"""Assembly: both delta shapes, and a truncated run that must not look whole."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.server_connectors.agui.assembly import (
    AgentToolResult,
    IncompleteRunError,
    RunAssembler,
    RunFailedError,
    StateOutput,
    StatusOutput,
    TextOutput,
    ToolCallOutput,
)
from switch_core.bridges.agent.server_connectors.agui.events import (
    AgUiProtocolError,
    parse_event,
)


def _run(assembler: RunAssembler, events: list[dict[str, Any]]) -> list[Any]:
    outputs: list[Any] = []
    for payload in events:
        outputs.extend(assembler.feed(parse_event(payload)))
    return outputs


def _finished() -> dict[str, Any]:
    return {"type": "RUN_FINISHED"}


# ── The triad shape ───────────────────────────────────────────────────────────


def test_text_triad_assembles_into_one_message() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "RUN_STARTED"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "Hello"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": " world"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="Hello world")
    ]


def test_two_sequential_messages() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "one"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "two"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            _finished(),
        ],
    )
    assembler.finish()
    assert [output.content for output in outputs] == ["one", "two"]


def test_empty_message_produces_no_output() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == []


# ── The chunk shape, which bypasses the triad ─────────────────────────────────


def test_text_chunks_assemble_without_any_triad_event() -> None:
    # The trap this whole module exists for: handle only the triad and a
    # chunk-based producer's entire reply vanishes with no error.
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {
                "type": "TEXT_MESSAGE_CHUNK",
                "messageId": "m1",
                "role": "assistant",
                "delta": "Hel",
            },
            {"type": "TEXT_MESSAGE_CHUNK", "delta": "lo"},
            {"type": "TEXT_MESSAGE_CHUNK", "delta": " there"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="Hello there")
    ]


def test_new_message_id_in_a_chunk_closes_the_previous_message() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "TEXT_MESSAGE_CHUNK", "messageId": "m1", "delta": "first"},
            {"type": "TEXT_MESSAGE_CHUNK", "messageId": "m2", "delta": "second"},
            _finished(),
        ],
    )
    assembler.finish()
    assert [(output.message_id, output.content) for output in outputs] == [
        ("m1", "first"),
        ("m2", "second"),
    ]


def test_tool_call_chunks_assemble() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {
                "type": "TOOL_CALL_CHUNK",
                "toolCallId": "c1",
                "toolCallName": "post_message",
                "delta": '{"body"',
            },
            {"type": "TOOL_CALL_CHUNK", "delta": ':"hi"}'},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        ToolCallOutput(
            tool_call_id="c1", name="post_message", arguments='{"body":"hi"}'
        )
    ]


def test_tool_chunk_arguments_before_a_named_call_is_an_error() -> None:
    assembler = RunAssembler()
    with pytest.raises(AgUiProtocolError, match="before naming a tool call"):
        assembler.feed(parse_event({"type": "TOOL_CALL_CHUNK", "delta": "{}"}))


# ── Tool calls, triad shape ───────────────────────────────────────────────────


def test_tool_call_triad_assembles() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "c1",
                "toolCallName": "read_context",
            },
            {"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": '{"limit"'},
            {"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": ":50}"},
            {"type": "TOOL_CALL_END", "toolCallId": "c1"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        ToolCallOutput(tool_call_id="c1", name="read_context", arguments='{"limit":50}')
    ]


def test_parallel_tool_calls_keep_their_arguments_apart() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "c1",
                "toolCallName": "post_message",
            },
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "c2",
                "toolCallName": "read_context",
            },
            {"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": "AAA"},
            {"type": "TOOL_CALL_ARGS", "toolCallId": "c2", "delta": "BBB"},
            {"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": "aaa"},
            {"type": "TOOL_CALL_END", "toolCallId": "c1"},
            {"type": "TOOL_CALL_END", "toolCallId": "c2"},
            _finished(),
        ],
    )
    assembler.finish()
    assert [(o.tool_call_id, o.arguments) for o in outputs] == [
        ("c1", "AAAaaa"),
        ("c2", "BBB"),
    ]


def test_arguments_for_an_unknown_tool_call_raise() -> None:
    assembler = RunAssembler()
    with pytest.raises(AgUiProtocolError, match="unknown tool call"):
        assembler.feed(
            parse_event({"type": "TOOL_CALL_ARGS", "toolCallId": "nope", "delta": "x"})
        )


def test_agent_executed_tool_result_is_recorded_not_executed() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "TOOL_CALL_RESULT", "toolCallId": "c1", "content": "42"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [AgentToolResult(tool_call_id="c1", content="42")]


# ── Draining what the run left open ───────────────────────────────────────────


def test_run_finished_closes_an_open_chunk_message() -> None:
    # Chunk output has no explicit end, so the reply is still open when the run
    # finishes. Dropping it would lose the whole answer.
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "TEXT_MESSAGE_CHUNK", "messageId": "m1", "delta": "dangling"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="dangling")
    ]


def test_run_finished_closes_an_open_tool_call() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "c1",
                "toolCallName": "post_message",
            },
            {"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": "{}"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        ToolCallOutput(tool_call_id="c1", name="post_message", arguments="{}")
    ]


# ── Termination: the point of the exercise ────────────────────────────────────


def test_stream_without_a_terminator_is_incomplete() -> None:
    # AG-UI's own client reports this as a SUCCESSFUL run carrying the partial
    # message. Switch must not.
    assembler = RunAssembler()
    _run(
        assembler,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m1",
                "delta": "Transferring $50,0",
            },
        ],
    )
    with pytest.raises(IncompleteRunError, match="without RUN_FINISHED or RUN_ERROR"):
        assembler.finish()


def test_a_run_that_produced_output_still_needs_a_terminator() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {
                "type": "TEXT_MESSAGE_CONTENT",
                "messageId": "m1",
                "delta": "looks complete",
            },
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
        ],
    )
    assert outputs  # a plausible-looking answer was produced ...
    with pytest.raises(IncompleteRunError):
        assembler.finish()  # ... and it is still not a finished run


def test_empty_stream_is_incomplete() -> None:
    assembler = RunAssembler()
    with pytest.raises(IncompleteRunError):
        assembler.finish()


def test_run_error_raises_with_its_message_and_code() -> None:
    assembler = RunAssembler()
    _run(
        assembler,
        [{"type": "RUN_ERROR", "message": "model unavailable", "code": "E42"}],
    )
    with pytest.raises(RunFailedError, match="model unavailable") as excinfo:
        assembler.finish()
    assert excinfo.value.code == "E42"


def test_events_after_termination_are_rejected() -> None:
    assembler = RunAssembler()
    _run(assembler, [_finished()])
    with pytest.raises(AgUiProtocolError, match="after the run terminated"):
        assembler.feed(parse_event({"type": "TEXT_MESSAGE_CHUNK", "delta": "late"}))


# ── Status, state, and events we deliberately ignore ──────────────────────────


def test_step_started_becomes_a_status_line() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler, [{"type": "STEP_STARTED", "stepName": "retrieve"}, _finished()]
    )
    assembler.finish()
    assert outputs == [StatusOutput(detail="retrieve")]


def test_state_snapshot_and_delta_pass_through() -> None:
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "STATE_SNAPSHOT", "snapshot": {"n": 1}},
            {
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/n", "value": 2}],
            },
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        StateOutput(snapshot={"n": 1}),
        StateOutput(delta=[{"op": "replace", "path": "/n", "value": 2}]),
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "RAW", "event": {}},
        {"type": "CUSTOM", "name": "x", "value": 1},
        {"type": "REASONING_START"},
        {"type": "REASONING_MESSAGE_CONTENT", "delta": "internal musing"},
        {"type": "THINKING_START"},
        {"type": "MESSAGES_SNAPSHOT", "messages": []},
        {"type": "SOME_FUTURE_EVENT"},
    ],
)
def test_ignored_and_unknown_events_produce_nothing_and_do_not_raise(
    payload: dict[str, Any],
) -> None:
    assembler = RunAssembler()
    assert assembler.feed(parse_event(payload)) == []


def test_reasoning_content_never_reaches_the_room() -> None:
    # Reasoning is internal to the model; a room is not a debugger.
    assembler = RunAssembler()
    outputs = _run(
        assembler,
        [
            {"type": "REASONING_MESSAGE_START", "messageId": "r1"},
            {"type": "REASONING_MESSAGE_CONTENT", "messageId": "r1", "delta": "hmm"},
            {"type": "REASONING_MESSAGE_END", "messageId": "r1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "the answer"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            _finished(),
        ],
    )
    assembler.finish()
    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="the answer")
    ]
