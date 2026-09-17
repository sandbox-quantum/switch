"""Slack uses SDK publication, and handles no native stop event."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration.slack import adapter as slack_adapter
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackReactionsRateLimited,
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


async def test_a_removal_slack_will_not_make_is_said_out_loud(caplog):
    """A mark that does not come off is the one failure a reader can see.

    Slack answering `message_not_found` to a removal is taken as the mark
    having gone with the message, and the caller is told it succeeded. When the
    message is in fact there that is a reaction left on it for good — the
    caller has been told there is nothing left to take off, so nothing tries
    again. Silently is the one way this must not happen.
    """
    slack, client = adapter()
    client.reaction_error = "message_not_found"
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="queued", on=False, force=True
    )

    assert "could not find 1.0 in C1 to take the queued reaction off" in caplog.text


async def test_a_removal_skipped_for_a_message_slack_lost_earlier_says_so(caplog):
    """The message goes in the cache once and every later mark reads it.

    So the addition that put it there is not the only removal that never
    reaches Slack, and a turn whose mark is stranded this way is one that never
    called Slack at all — there is nothing for a request log to show.
    """
    slack, client = adapter()
    client.reaction_error = "message_not_found"
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="queued", on=True
    )
    client.reaction_error = None
    caplog.clear()
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="queued", on=False, force=True
    )

    assert not client.reactions
    assert "Not asking Slack to take the queued reaction off 1.0 in C1" in caplog.text


async def test_a_rate_limited_reaction_stops_the_asking_until_slack_says_when(
    monkeypatch,
):
    """The publisher redraws on a timer, so a refusal it retries costs a call.

    Every few seconds, per turn still wanting its mark — which is how a
    workspace that metered one reaction call stayed metered, the retries
    holding the limit open against themselves. The window Slack names is
    waited out instead, and the turn keeps asking so the mark still lands.
    """
    slack, client = adapter()
    now = 1000.0
    monkeypatch.setattr(slack_adapter.time, "monotonic", lambda: now)
    client.reaction_error = "ratelimited"
    client.reaction_error_headers = {"Retry-After": "7"}

    with pytest.raises(SlackReactionsRateLimited):
        await slack.mark_activity(
            "C1", "C1:1.0", agent_name="worker", mark="working", on=False, force=True
        )

    client.reaction_error = None
    for now in (1000.0, 1006.9):
        with pytest.raises(SlackReactionsRateLimited):
            await slack.mark_activity(
                "C1",
                "C1:2.0",
                agent_name="worker",
                mark="working",
                on=False,
                force=True,
            )
    assert not client.reactions

    now = 1007.1
    await slack.mark_activity(
        "C1", "C1:2.0", agent_name="worker", mark="working", on=False, force=True
    )
    assert client.reactions == [("remove", "2.0", "eyes")]


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
