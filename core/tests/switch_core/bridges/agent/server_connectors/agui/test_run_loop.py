"""The continuation loop, driven by a scripted sequence of runs."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from switch_core.bridges.agent.server_connectors.agui import dispatch as dispatch_module
from switch_core.bridges.agent.server_connectors.agui.assembly import (
    IncompleteRunError,
    RunFailedError,
    StatusOutput,
    TextOutput,
)
from switch_core.bridges.agent.server_connectors.agui.events import (
    AgUiEvent,
    parse_event,
)
from switch_core.bridges.agent.server_connectors.agui.request import (
    RunAgentInput,
    Tool,
    UserMessage,
)
from switch_core.bridges.agent.server_connectors.agui.run_loop import (
    AgUiRunLoop,
    IterationLimitError,
)

AGENT_ID = "agent-1"
SESSION_KEY = "session-1"


class _ScriptedClient:
    """Replays one scripted event list per run, recording each request."""

    def __init__(self, runs: list[list[dict[str, Any]]]) -> None:
        self._runs = runs
        self.requests: list[RunAgentInput] = []

    async def run(self, request: RunAgentInput) -> AsyncIterator[AgUiEvent]:
        self.requests.append(request)
        if not self._runs:
            raise AssertionError("the loop made more runs than the script allows")
        for payload in self._runs.pop(0):
            yield parse_event(payload)


class _Dispatcher:
    """Stands in for `call_operation`."""

    def __init__(self, result: Any = "ok") -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.result


@pytest.fixture
def dispatcher(monkeypatch: pytest.MonkeyPatch) -> _Dispatcher:
    rec = _Dispatcher()
    monkeypatch.setattr(dispatch_module, "call_operation", rec)
    return rec


def _loop(client: _ScriptedClient, max_iterations: int = 16) -> AgUiRunLoop:
    return AgUiRunLoop(
        client=client,  # type: ignore[arg-type]
        tools=[Tool(name="post_message", description="Post.", parameters={})],
        agent_id=AGENT_ID,
        session_key=SESSION_KEY,
        max_iterations=max_iterations,
    )


async def _drive(loop: AgUiRunLoop, state: Any = None) -> list[Any]:
    return [
        output
        async for output in loop.run(
            thread_id="thread-1",
            messages=[UserMessage(id="u1", content="do the thing")],
            context=[],
            state=state,
        )
    ]


def _text(message_id: str, content: str) -> list[dict[str, Any]]:
    return [
        {"type": "TEXT_MESSAGE_START", "messageId": message_id, "role": "assistant"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": message_id, "delta": content},
        {"type": "TEXT_MESSAGE_END", "messageId": message_id},
    ]


def _tool(call_id: str, name: str, arguments: str) -> list[dict[str, Any]]:
    return [
        {"type": "TOOL_CALL_START", "toolCallId": call_id, "toolCallName": name},
        {"type": "TOOL_CALL_ARGS", "toolCallId": call_id, "delta": arguments},
        {"type": "TOOL_CALL_END", "toolCallId": call_id},
    ]


# ── One run, no tools ─────────────────────────────────────────────────────────


async def test_a_run_with_no_tool_calls_finishes_in_one_pass(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [
                {"type": "RUN_STARTED"},
                *_text("m1", "here you go"),
                {"type": "RUN_FINISHED"},
            ]
        ]
    )
    outputs = await _drive(_loop(client))

    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="here you go")
    ]
    assert len(client.requests) == 1
    assert dispatcher.calls == []


# ── Tool calls drive a continuation ───────────────────────────────────────────


async def test_a_tool_call_produces_a_second_run_carrying_its_result(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [
                {"type": "RUN_STARTED"},
                *_tool("c1", "post_message", '{"body":"hi"}'),
                {"type": "RUN_FINISHED"},
            ],
            [{"type": "RUN_STARTED"}, *_text("m1", "posted"), {"type": "RUN_FINISHED"}],
        ]
    )
    outputs = await _drive(_loop(client))

    assert [output.content for output in outputs] == ["posted"]
    assert len(client.requests) == 2
    assert dispatcher.calls[0]["operation"] == "post_message"

    # The continuation replays the agent's own turn and then the result.
    followup = client.requests[1].messages
    assert [message.role for message in followup] == ["user", "assistant", "tool"]
    assert followup[2].tool_call_id == "c1"  # type: ignore[union-attr]


async def test_text_alongside_a_tool_call_still_reaches_the_room(
    dispatcher: _Dispatcher,
) -> None:
    # An agent that narrates before acting should be heard immediately, not
    # held until the whole turn resolves.
    client = _ScriptedClient(
        [
            [
                *_text("m1", "let me post that"),
                *_tool("c1", "post_message", "{}"),
                {"type": "RUN_FINISHED"},
            ],
            [*_text("m2", "done"), {"type": "RUN_FINISHED"}],
        ]
    )
    outputs = await _drive(_loop(client))
    assert [output.content for output in outputs] == ["let me post that", "done"]


async def test_parallel_tool_calls_all_execute_before_the_next_run(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [
                *_tool("c1", "post_message", "{}"),
                *_tool("c2", "read_context", "{}"),
                {"type": "RUN_FINISHED"},
            ],
            [*_text("m1", "both done"), {"type": "RUN_FINISHED"}],
        ]
    )
    await _drive(_loop(client))

    assert [call["operation"] for call in dispatcher.calls] == [
        "post_message",
        "read_context",
    ]
    assert [message.role for message in client.requests[1].messages] == [
        "user",
        "assistant",
        "tool",
        "tool",
    ]


async def test_each_run_gets_a_fresh_run_id_on_the_same_thread(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [*_tool("c1", "post_message", "{}"), {"type": "RUN_FINISHED"}],
            [*_text("m1", "ok"), {"type": "RUN_FINISHED"}],
        ]
    )
    await _drive(_loop(client))

    assert client.requests[0].run_id != client.requests[1].run_id
    assert {request.thread_id for request in client.requests} == {"thread-1"}


async def test_tools_are_resent_on_every_iteration(dispatcher: _Dispatcher) -> None:
    # This is the cost that makes the room-scoped subset necessary rather than
    # tidy, so it is worth pinning that it really does happen every time.
    client = _ScriptedClient(
        [
            [*_tool("c1", "post_message", "{}"), {"type": "RUN_FINISHED"}],
            [*_text("m1", "ok"), {"type": "RUN_FINISHED"}],
        ]
    )
    await _drive(_loop(client))
    assert all(request.tools for request in client.requests)


# ── The loop is bounded ───────────────────────────────────────────────────────


async def test_an_endless_tool_loop_is_abandoned_loudly(
    dispatcher: _Dispatcher,
) -> None:
    # Neither the protocol nor the AG-UI SDK bounds this, so it is ours to do.
    forever = [
        [*_tool(f"c{i}", "post_message", "{}"), {"type": "RUN_FINISHED"}]
        for i in range(10)
    ]
    client = _ScriptedClient(forever)

    with pytest.raises(IterationLimitError, match="still calling tools"):
        await _drive(_loop(client, max_iterations=3))

    assert len(client.requests) == 3


async def test_the_cap_does_not_fire_when_the_agent_stops_in_time(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [*_tool("c1", "post_message", "{}"), {"type": "RUN_FINISHED"}],
            [*_tool("c2", "post_message", "{}"), {"type": "RUN_FINISHED"}],
            [*_text("m1", "finally"), {"type": "RUN_FINISHED"}],
        ]
    )
    outputs = await _drive(_loop(client, max_iterations=3))
    assert [output.content for output in outputs] == ["finally"]


# ── Failures propagate rather than truncating the turn ────────────────────────


async def test_a_truncated_continuation_raises(dispatcher: _Dispatcher) -> None:
    client = _ScriptedClient(
        [
            [*_tool("c1", "post_message", "{}"), {"type": "RUN_FINISHED"}],
            [*_text("m1", "partial answer")],  # no terminator
        ]
    )
    with pytest.raises(IncompleteRunError):
        await _drive(_loop(client))


async def test_a_run_error_propagates(dispatcher: _Dispatcher) -> None:
    client = _ScriptedClient([[{"type": "RUN_ERROR", "message": "model unavailable"}]])
    with pytest.raises(RunFailedError, match="model unavailable"):
        await _drive(_loop(client))


async def test_a_refused_tool_does_not_end_the_turn(dispatcher: _Dispatcher) -> None:
    # The agent should get the refusal back and be able to carry on.
    client = _ScriptedClient(
        [
            [
                *_tool("c1", "connect_to_room", '{"room_id":"elsewhere"}'),
                {"type": "RUN_FINISHED"},
            ],
            [*_text("m1", "understood, carrying on"), {"type": "RUN_FINISHED"}],
        ]
    )
    outputs = await _drive(_loop(client))

    assert [output.content for output in outputs] == ["understood, carrying on"]
    assert dispatcher.calls == []
    tool_message = client.requests[1].messages[-1]
    assert tool_message.error is not None  # type: ignore[union-attr]


# ── State ─────────────────────────────────────────────────────────────────────


async def test_a_state_snapshot_is_carried_into_the_next_run(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [
                {"type": "STATE_SNAPSHOT", "snapshot": {"step": 1}},
                *_tool("c1", "post_message", "{}"),
                {"type": "RUN_FINISHED"},
            ],
            [*_text("m1", "ok"), {"type": "RUN_FINISHED"}],
        ]
    )
    await _drive(_loop(client))
    assert client.requests[1].state == {"step": 1}


async def test_a_state_delta_is_applied_not_forwarded_raw(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient(
        [
            [
                {"type": "STATE_SNAPSHOT", "snapshot": {"step": 1}},
                {
                    "type": "STATE_DELTA",
                    "delta": [{"op": "replace", "path": "/step", "value": 2}],
                },
                *_tool("c1", "post_message", "{}"),
                {"type": "RUN_FINISHED"},
            ],
            [*_text("m1", "ok"), {"type": "RUN_FINISHED"}],
        ]
    )
    await _drive(_loop(client))
    assert client.requests[1].state == {"step": 2}


async def test_state_survives_to_the_end_of_the_turn(dispatcher: _Dispatcher) -> None:
    client = _ScriptedClient(
        [
            [
                {"type": "STATE_SNAPSHOT", "snapshot": {"seen": ["a"]}},
                {"type": "RUN_FINISHED"},
            ]
        ]
    )
    loop = _loop(client)
    await _drive(loop)
    assert loop.latest_state == {"seen": ["a"]}


async def test_state_is_never_surfaced_to_the_room(dispatcher: _Dispatcher) -> None:
    client = _ScriptedClient(
        [
            [
                {"type": "STATE_SNAPSHOT", "snapshot": {"secret": "scratch"}},
                {"type": "STEP_STARTED", "stepName": "thinking"},
                *_text("m1", "answer"),
                {"type": "RUN_FINISHED"},
            ]
        ]
    )
    outputs = await _drive(_loop(client))
    assert outputs == [
        StatusOutput(detail="thinking"),
        TextOutput(message_id="m1", role="assistant", content="answer"),
    ]


# ── What we send ──────────────────────────────────────────────────────────────


async def test_the_first_run_carries_the_supplied_history(
    dispatcher: _Dispatcher,
) -> None:
    client = _ScriptedClient([[*_text("m1", "ok"), {"type": "RUN_FINISHED"}]])
    await _drive(_loop(client))

    body = json.loads(client.requests[0].model_dump_json(by_alias=True))
    assert body["messages"][0]["content"] == "do the thing"
    assert body["threadId"] == "thread-1"
