"""The connector: backgrounded runs, per-room serialisation, loud failures.

Follows the harness the OpenCode connector established — a recording reporter
and a duck-typed fake client assigned straight onto the private attribute — so
nothing here needs a network, a database or a running Switch.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from switch_core.bridges.agent.protocol.types import CommandPayload, MessagePayload
from switch_core.bridges.agent.server_connectors.agui import (
    connector as connector_module,
)
from switch_core.bridges.agent.server_connectors.agui.client import AgUiTimeoutError
from switch_core.bridges.agent.server_connectors.agui.connector import (
    MAX_QUEUED_TURNS_PER_ROOM,
    AgUiConnectionConfig,
    AgUiConnector,
)
from switch_core.bridges.agent.server_connectors.agui.events import (
    AgUiEvent,
    parse_event,
)
from switch_core.bridges.agent.server_connectors.agui.request import RunAgentInput
from switch_core.bridges.agent.server_connectors.base import ConnectorReporter

AGENT_NAME = "research-bot"
AGENT_ID = "agent-uuid-1"
ROOM_ID = "room-1"


class _FakeReporter(ConnectorReporter):
    def __init__(self) -> None:
        self.messages: list[str] = []
        self.statuses: list[str] = []
        self.typing: list[bool] = []

    async def send_message(self, room_id: str, content: str) -> None:
        self.messages.append(content)

    async def report_events(self, room_id: str, events: Any) -> None:
        pass

    async def send_status(self, room_id: str, detail: str) -> None:
        self.statuses.append(detail)

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        self.typing.append(is_typing)


class _FakeClient:
    """Replays scripted runs, optionally stalling so a test can interleave."""

    def __init__(
        self,
        runs: list[list[dict[str, Any]]],
        gate: asyncio.Event | None = None,
        raises: Exception | None = None,
    ) -> None:
        self._runs = runs
        self._gate = gate
        self._raises = raises
        self.requests: list[RunAgentInput] = []
        self.started = 0

    async def run(self, request: RunAgentInput) -> AsyncIterator[AgUiEvent]:
        self.started += 1
        self.requests.append(request)
        if self._raises is not None:
            raise self._raises
        if self._gate is not None:
            await self._gate.wait()
        for payload in self._runs.pop(0) if self._runs else []:
            yield parse_event(payload)


def _text_run(content: str) -> list[dict[str, Any]]:
    return [
        {"type": "RUN_STARTED"},
        {"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": content},
        {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
        {"type": "RUN_FINISHED"},
    ]


def _config(**overrides: Any) -> AgUiConnectionConfig:
    return AgUiConnectionConfig(
        endpoint_url="https://agent.example/agui",
        agent_name=AGENT_NAME,
        **overrides,
    )


def _message(body: str = "what is the status?") -> MessagePayload:
    return MessagePayload(
        addressed=True,
        sender="@someone:switch.local",
        sender_name="christian",
        message_id="$evt1",
        body=body,
        timestamp=1,
    )


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the two bits of Switch the connector reaches out to."""

    async def fake_call_operation(**kwargs: Any) -> Any:
        assert kwargs["operation"] == "read_context"
        return {"threads": [], "truncated": False, "oldest_timestamp": None}

    async def fake_bind(*args: Any, **kwargs: Any) -> bool:
        return True

    monkeypatch.setattr(connector_module, "call_operation", fake_call_operation)
    monkeypatch.setattr(
        connector_module, "bind_room_for_connectionless_caller", fake_bind
    )
    # `get_protocol()` is evaluated as an argument to the bind call, so
    # stubbing the bind alone is not enough to keep the real service out.
    monkeypatch.setattr(connector_module, "get_protocol", lambda: object())


def _connector(client: _FakeClient, **overrides: Any) -> AgUiConnector:
    conn = AgUiConnector(_config(**overrides))
    conn._client = client  # type: ignore[assignment]
    conn._agent_ids[AGENT_NAME] = AGENT_ID
    return conn


async def _settle(connector: AgUiConnector) -> None:
    """Wait for every backgrounded turn to finish."""
    while connector._runs:
        await asyncio.gather(*list(connector._runs), return_exceptions=True)


# ── Discovery and profile ─────────────────────────────────────────────────────


async def test_one_endpoint_yields_exactly_one_agent() -> None:
    # AG-UI has no discovery mechanism, so there is nothing to enumerate.
    agents = await AgUiConnector(_config()).discover_agents()
    assert len(agents) == 1
    assert agents[0].name == AGENT_NAME


async def test_the_agent_can_take_part_in_the_task_protocol() -> None:
    agents = await AgUiConnector(_config()).discover_agents()
    profile = agents[0].integration_profile
    assert profile.task_protocol.can_accept
    assert profile.message_exchange


async def test_interrupt_is_declared_unsupported() -> None:
    # There is no cancellation path: a run in flight cannot be reached, and
    # AG-UI has no RUN_CANCELLED either. Claiming otherwise would be a lie.
    agents = await AgUiConnector(_config()).discover_agents()
    assert agents[0].integration_profile.command_capabilities.interrupt == "unsupported"


# ── A turn end to end ─────────────────────────────────────────────────────────


async def test_a_room_message_produces_a_room_reply(wired: None) -> None:
    client = _FakeClient([_text_run("the deploy is green")])
    connector = _connector(client)
    reporter = _FakeReporter()

    assert (
        await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
        is None
    )
    await _settle(connector)

    assert reporter.messages == ["the deploy is green"]


async def test_handle_message_returns_before_the_run_finishes(wired: None) -> None:
    # The heartbeat constraint in one test: the poll loop must be free again
    # immediately, not after the model has finished thinking.
    gate = asyncio.Event()
    client = _FakeClient([_text_run("eventually")], gate=gate)
    connector = _connector(client)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)

    assert reporter.messages == []  # nothing posted yet ...
    gate.set()
    await _settle(connector)
    assert reporter.messages == ["eventually"]  # ... but it does arrive


async def test_typing_is_set_and_cleared(wired: None) -> None:
    client = _FakeClient([_text_run("done")])
    connector = _connector(client)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    assert reporter.typing == [True, False]


async def test_the_incoming_message_is_the_last_thing_the_agent_sees(
    wired: None,
) -> None:
    client = _FakeClient([_text_run("ok")])
    connector = _connector(client)

    await connector.handle_message(
        AGENT_NAME, ROOM_ID, _message("do the thing"), _FakeReporter()
    )
    await _settle(connector)

    assert client.requests[0].messages[-1].content == "do the thing"


async def test_the_run_carries_the_room_scoped_tools(wired: None) -> None:
    client = _FakeClient([_text_run("ok")])
    connector = _connector(client)

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), _FakeReporter())
    await _settle(connector)

    names = {tool.name for tool in client.requests[0].tools}
    assert "post_message" in names
    assert "connect_to_room" not in names


# ── Serialisation and backpressure ────────────────────────────────────────────


async def test_a_second_message_waits_for_the_first_run(wired: None) -> None:
    # Backgrounding gives up the poll loop's implicit serialisation, so the
    # connector has to provide it — otherwise two turns interleave in one room.
    gate = asyncio.Event()
    client = _FakeClient([_text_run("first"), _text_run("second")], gate=gate)
    connector = _connector(client)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message("one"), reporter)
    await connector.handle_message(AGENT_NAME, ROOM_ID, _message("two"), reporter)
    await asyncio.sleep(0)

    assert client.started == 1  # the second turn has not started

    gate.set()
    await _settle(connector)
    assert reporter.messages == ["first", "second"]


async def test_too_many_queued_turns_is_reported_not_absorbed(wired: None) -> None:
    gate = asyncio.Event()
    client = _FakeClient([_text_run("x") for _ in range(10)], gate=gate)
    connector = _connector(client)
    reporter = _FakeReporter()

    for index in range(MAX_QUEUED_TURNS_PER_ROOM + 1):
        await connector.handle_message(
            AGENT_NAME, ROOM_ID, _message(str(index)), reporter
        )

    assert any("too many queued" in message for message in reporter.messages)

    gate.set()
    await _settle(connector)


async def test_different_rooms_do_not_block_each_other(wired: None) -> None:
    gate = asyncio.Event()
    client = _FakeClient([_text_run("a"), _text_run("b")], gate=gate)
    connector = _connector(client)

    await connector.handle_message(AGENT_NAME, "room-a", _message(), _FakeReporter())
    await connector.handle_message(AGENT_NAME, "room-b", _message(), _FakeReporter())
    await asyncio.sleep(0)

    assert client.started == 2

    gate.set()
    await _settle(connector)


# ── Failures are surfaced into the room ───────────────────────────────────────


async def test_a_truncated_run_is_reported_in_the_room(wired: None) -> None:
    # The whole point of the terminator check, seen from the room's side.
    client = _FakeClient(
        [
            [
                {"type": "RUN_STARTED"},
                {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
                {
                    "type": "TEXT_MESSAGE_CONTENT",
                    "messageId": "m1",
                    "delta": "half an ans",
                },
            ]
        ]
    )
    connector = _connector(client)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    assert any("could not complete" in message for message in reporter.messages)


async def test_a_transport_failure_is_reported_in_the_room(wired: None) -> None:
    client = _FakeClient([], raises=AgUiTimeoutError("endpoint went silent"))
    connector = _connector(client)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    assert any("went silent" in message for message in reporter.messages)


async def test_an_unexpected_error_is_reported_rather_than_swallowed(
    wired: None,
) -> None:
    client = _FakeClient([], raises=RuntimeError("something nobody planned for"))
    connector = _connector(client)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    assert any("nobody planned for" in message for message in reporter.messages)


async def test_a_failed_turn_does_not_wedge_the_room(wired: None) -> None:
    # If the queue counter or the lock leaked on failure, the room would go
    # permanently deaf. It is worth proving it recovers.
    client = _FakeClient([_text_run("recovered")], raises=None)
    failing = _FakeClient([], raises=RuntimeError("boom"))
    connector = _connector(failing)
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    connector._client = client  # type: ignore[assignment]
    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    assert reporter.messages[-1] == "recovered"


# ── Commands and lifecycle ────────────────────────────────────────────────────


async def test_reset_clears_the_room_state(wired: None) -> None:
    connector = _connector(_FakeClient([]))
    connector._state[(AGENT_NAME, ROOM_ID)] = {"step": 3}

    await connector.handle_command(
        AGENT_NAME,
        ROOM_ID,
        CommandPayload(command="reset", user_id="u", user_name="christian"),
    )

    assert (AGENT_NAME, ROOM_ID) not in connector._state


async def test_stop_cancels_runs_in_flight(wired: None) -> None:
    gate = asyncio.Event()
    client = _FakeClient([_text_run("never arrives")], gate=gate)
    connector = _connector(client)

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), _FakeReporter())
    await asyncio.sleep(0)
    await connector.stop()

    assert connector._runs == set()


async def test_running_before_start_fails_loudly(wired: None) -> None:
    connector = AgUiConnector(_config())
    connector._agent_ids[AGENT_NAME] = AGENT_ID
    reporter = _FakeReporter()

    await connector.handle_message(AGENT_NAME, ROOM_ID, _message(), reporter)
    await _settle(connector)

    assert any("Connector not started" in message for message in reporter.messages)
