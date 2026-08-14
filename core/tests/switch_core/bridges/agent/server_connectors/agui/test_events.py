"""Event parsing: permissive about what we do not know, strict about corruption."""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.server_connectors.agui.events import (
    DEPRECATED_ALIASES,
    AgUiEvent,
    EventType,
    MalformedEventError,
    RunError,
    TextMessageChunk,
    TextMessageContent,
    TextMessageStart,
    ToolCallArgs,
    ToolCallStart,
    parse_event,
)


def test_camel_case_wire_fields_map_to_snake_case() -> None:
    event = parse_event(
        {
            "type": "TOOL_CALL_START",
            "toolCallId": "call-1",
            "toolCallName": "post_message",
        }
    )
    assert isinstance(event, ToolCallStart)
    assert event.tool_call_id == "call-1"
    assert event.tool_call_name == "post_message"


def test_text_message_content_parses() -> None:
    event = parse_event(
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "hi"}
    )
    assert isinstance(event, TextMessageContent)
    assert event.delta == "hi"


def test_chunk_event_tolerates_every_field_being_absent() -> None:
    # All fields on the chunk shape are optional by specification.
    event = parse_event({"type": "TEXT_MESSAGE_CHUNK"})
    assert isinstance(event, TextMessageChunk)
    assert event.message_id is None
    assert event.delta is None


def test_unknown_event_type_is_returned_not_rejected() -> None:
    # AG-UI adds events without a changelog. An unrecognised type must not be
    # able to fail a run.
    event = parse_event({"type": "SOME_FUTURE_EVENT", "whatever": 1})
    assert type(event) is AgUiEvent
    assert event.type == "SOME_FUTURE_EVENT"


def test_unknown_fields_on_a_known_event_are_preserved() -> None:
    event = parse_event(
        {"type": "TEXT_MESSAGE_START", "messageId": "m1", "futureField": "kept"}
    )
    assert isinstance(event, TextMessageStart)
    assert event.model_extra is not None
    assert event.model_extra["futureField"] == "kept"


@pytest.mark.parametrize(
    "alias,expected",
    sorted((alias, target.value) for alias, target in DEPRECATED_ALIASES.items()),
)
def test_deprecated_thinking_aliases_are_normalised(alias: str, expected: str) -> None:
    # THINKING_* was renamed to REASONING_* in 0.0.45; producers pinned older
    # still emit the old names. They must never reach the assembler as-is.
    event = parse_event({"type": alias})
    assert event.type == expected


def test_every_alias_target_is_a_real_event_type() -> None:
    known = {member.value for member in EventType}
    assert {target.value for target in DEPRECATED_ALIASES.values()} <= known


def test_missing_type_is_malformed() -> None:
    with pytest.raises(MalformedEventError, match="no usable 'type'"):
        parse_event({"messageId": "m1"})


def test_non_object_frame_is_malformed() -> None:
    with pytest.raises(MalformedEventError, match="must be a JSON object"):
        parse_event(["not", "an", "object"])


def test_empty_type_is_malformed() -> None:
    with pytest.raises(MalformedEventError, match="no usable 'type'"):
        parse_event({"type": ""})


def test_missing_required_field_is_malformed() -> None:
    # `delta` is what the event exists to carry; without it there is nothing to
    # do but fail loudly.
    with pytest.raises(MalformedEventError, match="TEXT_MESSAGE_CONTENT"):
        parse_event({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1"})


def test_tool_call_args_requires_its_delta() -> None:
    with pytest.raises(MalformedEventError, match="TOOL_CALL_ARGS"):
        parse_event({"type": "TOOL_CALL_ARGS", "toolCallId": "call-1"})


def test_run_error_requires_a_message() -> None:
    with pytest.raises(MalformedEventError, match="RUN_ERROR"):
        parse_event({"type": "RUN_ERROR", "code": "boom"})


def test_run_error_carries_message_and_code() -> None:
    event = parse_event({"type": "RUN_ERROR", "message": "upstream died", "code": "E1"})
    assert isinstance(event, RunError)
    assert event.message == "upstream died"
    assert event.code == "E1"


def test_run_started_tolerates_absent_ids() -> None:
    # Switch already knows the run it started, so a producer that omits these
    # is sloppy rather than unusable.
    event = parse_event({"type": "RUN_STARTED"})
    assert event.type == EventType.RUN_STARTED


def test_tool_call_args_parses() -> None:
    event = parse_event({"type": "TOOL_CALL_ARGS", "toolCallId": "c1", "delta": '{"a"'})
    assert isinstance(event, ToolCallArgs)
    assert event.delta == '{"a"'


def test_the_full_event_taxonomy_is_accounted_for() -> None:
    # AG-UI defines 33 event types: 28 current, plus 5 deprecated THINKING_*
    # aliases that are normalised away rather than modelled. The count is
    # pinned so a spec change shows up as a failure instead of a silent gap.
    # (The AG-UI README's own "~16" figure is wrong and widely copied.)
    assert len(EventType) == 28
    assert len(DEPRECATED_ALIASES) == 5
