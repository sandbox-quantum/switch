"""Slack uses SDK publication without legacy progress or native stop handling."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

from .slack_fakes import FakeWebClient
from .test_session_activity import _turn


def adapter():
    result = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )
    client = FakeWebClient()
    result._web_client = client
    return result, client


async def test_legacy_reports_cannot_fall_back_to_status_messages_or_mentions():
    slack, client = adapter()
    for state in ("working", "awaiting-input", "idle"):
        await slack.apply_runtime_state(
            "C1",
            "worker",
            state,
            mention_handle="UOWNER",
            thread_root_id="C1:1.0",
            deeplink_url="https://example.test",
            detail="Private legacy status",
        )
        await slack.reposition_runtime_state("C1", "worker", "C1:2.0")
    assert not client.posted
    assert not client.updated
    assert not client.reactions
    assert not slack._runtime_locks


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
    await slack.mark_activity("C1", "C1:1.0", agent_name="worker", working=True)
    client.reaction_error = None
    await slack.mark_activity("C1", "1.0", agent_name="worker", working=True)
    assert not client.reactions
    assert not caplog.records


async def test_reaction_force_reconciles_after_restart():
    slack, client = adapter()
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", working=False, force=True
    )
    assert client.reactions == [("remove", "1.0", "eyes")]


def test_native_progress_setting_is_absent_from_registration():
    assert (
        "agent_sessions" not in SlackConnectionConfig.model_json_schema()["properties"]
    )


async def test_activity_layout_is_an_adapter_capability_not_a_slack_type_check():
    platform = SimpleNamespace(
        separate_activity_log=True,
        supports_activity_reactions=True,
        post_rich=AsyncMock(side_effect=["C1:status", "C1:log"]),
        update_rich=AsyncMock(),
        mark_activity=AsyncMock(),
        notify_working=AsyncMock(),
    )
    activity = SessionTurnActivity(platform)
    kwargs = dict(
        session_id="s",
        channel_id="C1",
        thread_root_id="C1:root",
        asked_on="C1:asker",
        agent_name="worker",
        elapsed_seconds=5,
    )
    await activity.publish([], _turn("running"), **kwargs)
    await activity.publish([], _turn("completed"), **kwargs)
    status, log = platform.post_rich.call_args_list
    assert status.args[2].status_only
    assert log.args[2].tool_log
    assert [call.args[1] for call in platform.update_rich.call_args_list] == [
        "C1:status",
        "C1:log",
    ]
    assert [
        call.kwargs["working"] for call in platform.mark_activity.call_args_list
    ] == [True, False]


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
