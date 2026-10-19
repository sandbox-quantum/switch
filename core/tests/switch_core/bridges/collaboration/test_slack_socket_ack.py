"""A Socket Mode event is stored before Slack is told it arrived.

Slack sends an event again when it is not acknowledged within three seconds,
so acknowledging only once the event is stored means a process that stops in
between is sent the event again instead of losing it. Storing that runs long
is acknowledged in time anyway, storing that fails is not acknowledged, so
Slack sends the event again, and the copy is stored, and a slash command or
button press, which Slack never sends again, is acknowledged first as before.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack import adapter as slack_module
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

from .slack_fakes import FakeWebClient


def _adapter() -> SlackAdapter:
    slack = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )
    slack._web_client = FakeWebClient()  # type: ignore[assignment]
    return slack


def _slack(order: list[str], stored: asyncio.Event | None = None) -> SlackAdapter:
    slack = _adapter()

    async def dispatch(*, envelope_type: str, payload: dict[str, Any]) -> None:
        if stored is not None:
            await stored.wait()
        order.append("stored")

    slack.dispatch_event = dispatch  # type: ignore[method-assign]
    return slack


def _socket(order: list[str]) -> Any:
    socket = AsyncMock()
    socket.send_socket_mode_response.side_effect = lambda _response: order.append(
        "acknowledged"
    )
    return socket


def _envelope(kind: str) -> SocketModeRequest:
    return SocketModeRequest(type=kind, envelope_id="envelope-1", payload={})


def _posted(envelope_id: str) -> SocketModeRequest:
    """Someone's post in a channel, as Slack delivers it, the same each time."""
    return SocketModeRequest(
        type="events_api",
        envelope_id=envelope_id,
        payload={
            "event": {
                "type": "message",
                "channel": "C1",
                "channel_type": "channel",
                "ts": "1700000000.000100",
                "user": "U1",
                "text": "hello",
            }
        },
    )


async def test_an_event_is_acknowledged_once_it_is_stored() -> None:
    order: list[str] = []
    slack = _slack(order)

    await slack._handle_socket_event(_socket(order), _envelope("events_api"))

    assert order == ["stored", "acknowledged"]


async def test_an_event_slow_to_store_is_acknowledged_in_time_and_still_stored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(slack_module, "SOCKET_ACK_WITHIN_SECONDS", 0.05)
    order: list[str] = []
    stored = asyncio.Event()
    slack = _slack(order, stored)

    handling = asyncio.create_task(
        slack._handle_socket_event(_socket(order), _envelope("events_api"))
    )
    await asyncio.sleep(0.2)
    assert order == ["acknowledged"]

    stored.set()
    await handling
    assert order == ["acknowledged", "stored"]


async def test_an_event_that_fails_to_store_is_not_acknowledged() -> None:
    order: list[str] = []
    slack = _slack(order)

    async def failing(*, envelope_type: str, payload: dict[str, Any]) -> None:
        raise RuntimeError("the database refused the post")

    slack.dispatch_event = failing  # type: ignore[method-assign]

    with pytest.raises(RuntimeError):
        await slack._handle_socket_event(_socket(order), _envelope("events_api"))

    assert order == []


async def test_an_event_that_failed_to_store_is_stored_when_sent_again() -> None:
    """Only the process that holds the bridge has its socket, so the copy
    Slack sends of an event that failed to store reaches the same adapter,
    which must not skip it as a message it has seen."""
    order: list[str] = []
    slack = _adapter()
    refusals = [RuntimeError("the database refused the post")]

    async def on_message(message: InboundMessage) -> None:
        if refusals:
            raise refusals.pop()
        order.append("stored")

    slack._on_message = on_message
    socket = _socket(order)

    with pytest.raises(RuntimeError):
        await slack._handle_socket_event(socket, _posted("envelope-1"))
    await slack._handle_socket_event(socket, _posted("envelope-2"))

    assert order == ["stored", "acknowledged"]


@pytest.mark.parametrize("kind", ["slash_commands", "interactive"])
async def test_a_command_or_press_is_acknowledged_before_it_is_handled(
    kind: str,
) -> None:
    order: list[str] = []
    slack = _slack(order)

    await slack._handle_socket_event(_socket(order), _envelope(kind))

    assert order == ["acknowledged", "stored"]
