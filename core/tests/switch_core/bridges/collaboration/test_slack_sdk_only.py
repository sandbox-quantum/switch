"""Slack uses SDK publication, and handles no native stop event."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

from .slack_fakes import FakeWebClient


def adapter():
    result = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )
    client = FakeWebClient()
    result._web_client = client
    return result, client


async def test_native_stop_event_is_acknowledged_without_interrupting_an_sdk_turn():
    slack, _ = adapter()
    slack._on_command = AsyncMock()
    socket = SimpleNamespace(send_socket_mode_response=AsyncMock())
    await slack._handle_socket_event(
        socket,
        SocketModeRequest(
            type="events_api",
            envelope_id="old-event",
            payload={
                "event": {
                    "type": "agent_session_stopped",
                    "channel_id": "C1",
                    "thread_ts": "1.0",
                }
            },
        ),
    )
    socket.send_socket_mode_response.assert_awaited_once()
    slack._on_command.assert_not_awaited()


@pytest.mark.parametrize("error", ["already_reacted", "message_not_found"])
async def test_reaction_cache_handles_expected_slack_refusals_quietly(error, caplog):
    slack, client = adapter()
    client.reaction_error = error
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="working", on=True
    )
    client.reaction_error = None
    await slack.mark_activity("C1", "1.0", agent_name="worker", mark="working", on=True)
    assert not client.reactions
    assert not caplog.records


async def test_reaction_force_reconciles_after_restart():
    slack, client = adapter()
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="working", on=False, force=True
    )
    assert client.reactions == [("remove", "1.0", "eyes")]


def test_native_progress_setting_is_absent_from_registration():
    assert (
        "agent_sessions" not in SlackConnectionConfig.model_json_schema()["properties"]
    )


async def test_typed_interrupt_still_routes_to_the_global_command():
    slack, _ = adapter()
    slack._on_command = AsyncMock()
    slack._channel_name_cache["C1"] = "test"
    await slack._handle_message_event(
        {
            "type": "message",
            "channel": "C1",
            "channel_type": "channel",
            "ts": "2.0",
            "thread_ts": "1.0",
            "user": "U1",
            "text": "!interrupt @worker",
        }
    )
    slack._on_command.assert_awaited_once()
    command = slack._on_command.call_args.args[0]
    assert command.command == "interrupt"
    assert command.args == "@worker"
    assert command.root_id == "C1:1.0"
