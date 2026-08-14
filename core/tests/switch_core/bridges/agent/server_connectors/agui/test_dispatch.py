"""Tool dispatch: refuse what is not offered, report what fails."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.agent.server_connectors.agui import dispatch as dispatch_module
from switch_core.bridges.agent.server_connectors.agui.assembly import ToolCallOutput
from switch_core.bridges.agent.server_connectors.agui.dispatch import (
    MAX_RESULT_CHARS,
    execute_tool_call,
)

AGENT_ID = "agent-1"
SESSION_KEY = "session-1"


class _Recorder:
    """Stands in for `call_operation`, recording how it was invoked."""

    def __init__(self, result: Any = None, raises: Exception | None = None) -> None:
        self.result = result
        self.raises = raises
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        return self.result


def _call(
    name: str = "post_message", arguments: str = '{"body":"hi"}'
) -> ToolCallOutput:
    return ToolCallOutput(tool_call_id="c1", name=name, arguments=arguments)


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder(result={"event_id": "$abc"})
    monkeypatch.setattr(dispatch_module, "call_operation", rec)
    return rec


# ── The happy path ────────────────────────────────────────────────────────────


async def test_successful_call_returns_a_tool_result_without_an_error(
    recorder: _Recorder,
) -> None:
    message = await execute_tool_call(
        _call(), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is None
    assert message.tool_call_id == "c1"
    assert "$abc" in message.content


async def test_the_call_is_dispatched_as_the_right_agent_and_session(
    recorder: _Recorder,
) -> None:
    # The session key is what binds the operation to a room, so getting this
    # wrong would run the agent's tool against the wrong conversation.
    await execute_tool_call(_call(), agent_id=AGENT_ID, session_key=SESSION_KEY)
    assert recorder.calls == [
        {
            "operation": "post_message",
            "arguments": {"body": "hi"},
            "agent_id": AGENT_ID,
            "connection_id": SESSION_KEY,
        }
    ]


async def test_empty_arguments_become_an_empty_object(recorder: _Recorder) -> None:
    await execute_tool_call(
        _call(name="list_participants", arguments=""),
        agent_id=AGENT_ID,
        session_key=SESSION_KEY,
    )
    assert recorder.calls[0]["arguments"] == {}


# ── The allowlist, enforced at dispatch ───────────────────────────────────────


async def test_an_unexposed_operation_is_refused_without_dispatching(
    recorder: _Recorder,
) -> None:
    # An agent can name any tool, including one it was never offered.
    # connect_to_room would let it evict a live session of itself elsewhere.
    message = await execute_tool_call(
        _call(name="connect_to_room", arguments='{"room_id":"other"}'),
        agent_id=AGENT_ID,
        session_key=SESSION_KEY,
    )
    assert message.error is not None
    assert "not available" in message.error
    assert recorder.calls == []


@pytest.mark.parametrize(
    "name", ["connect_to_room", "create_room", "archive_room", "update_agent_detail"]
)
async def test_administrative_operations_are_refused(
    recorder: _Recorder, name: str
) -> None:
    message = await execute_tool_call(
        _call(name=name, arguments="{}"), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is not None
    assert recorder.calls == []


async def test_a_wholly_invented_tool_name_is_refused(recorder: _Recorder) -> None:
    message = await execute_tool_call(
        _call(name="drop_database", arguments="{}"),
        agent_id=AGENT_ID,
        session_key=SESSION_KEY,
    )
    assert message.error is not None
    assert recorder.calls == []


# ── Failures are reported to the agent, not raised ────────────────────────────


async def test_malformed_arguments_come_back_as_an_error_result(
    recorder: _Recorder,
) -> None:
    message = await execute_tool_call(
        _call(arguments="{not json"), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is not None
    assert "not valid JSON" in message.error
    assert recorder.calls == []


async def test_non_object_arguments_come_back_as_an_error_result(
    recorder: _Recorder,
) -> None:
    message = await execute_tool_call(
        _call(arguments="[1,2,3]"), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is not None
    assert "must be a JSON object" in message.error


async def test_an_operation_that_raises_becomes_an_error_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Killing the room turn because one tool failed would be a worse outcome
    # than letting the model see the failure and correct itself.
    rec = _Recorder(raises=ValueError("Not connected to a room."))
    monkeypatch.setattr(dispatch_module, "call_operation", rec)

    message = await execute_tool_call(
        _call(), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is not None
    assert "Not connected to a room." in message.error


async def test_a_permission_error_becomes_an_error_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(raises=PermissionError("not permitted to address me here"))
    monkeypatch.setattr(dispatch_module, "call_operation", rec)

    message = await execute_tool_call(
        _call(name="send_targeted_message"), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is not None
    assert "not permitted" in message.error


async def test_an_unexpected_exception_still_becomes_an_error_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(raises=RuntimeError("something nobody anticipated"))
    monkeypatch.setattr(dispatch_module, "call_operation", rec)

    message = await execute_tool_call(
        _call(), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is not None
    assert "something nobody anticipated" in message.error


async def test_a_failed_result_is_distinguishable_from_an_empty_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The whole reason the error field exists. Without it, "the tool failed"
    # and "the tool returned nothing" look identical to the model.
    empty = _Recorder(result=None)
    monkeypatch.setattr(dispatch_module, "call_operation", empty)
    succeeded = await execute_tool_call(
        _call(), agent_id=AGENT_ID, session_key=SESSION_KEY
    )

    failed_rec = _Recorder(raises=ValueError("boom"))
    monkeypatch.setattr(dispatch_module, "call_operation", failed_rec)
    failed = await execute_tool_call(
        _call(), agent_id=AGENT_ID, session_key=SESSION_KEY
    )

    assert succeeded.error is None
    assert failed.error is not None


# ── Result encoding ───────────────────────────────────────────────────────────


async def test_structured_results_are_json_encoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(result={"threads": [{"id": "$1"}], "truncated": False})
    monkeypatch.setattr(dispatch_module, "call_operation", rec)

    message = await execute_tool_call(
        _call(name="read_context"), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert '"truncated": false' in message.content


async def test_unserialisable_results_do_not_break_the_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(result={"when": object()})
    monkeypatch.setattr(dispatch_module, "call_operation", rec)

    message = await execute_tool_call(
        _call(), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert message.error is None
    assert message.content


async def test_oversized_results_are_truncated_visibly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A tool result is re-sent on every later iteration, so an unbounded one is
    # paid for repeatedly.
    rec = _Recorder(result="x" * (MAX_RESULT_CHARS * 2))
    monkeypatch.setattr(dispatch_module, "call_operation", rec)

    message = await execute_tool_call(
        _call(name="read_context"), agent_id=AGENT_ID, session_key=SESSION_KEY
    )
    assert "truncated at" in message.content
    assert len(message.content) < MAX_RESULT_CHARS * 1.1
