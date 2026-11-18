"""Slack's side of `!work-threads`, and the asker a stream is addressed to.

A turn asked at the top of a channel can do its work in a thread under a
message of the agent's own: a divider at the channel root, an agent session on
its thread for the asker, and the turn's stream in that thread. Nobody follows
that thread, so the stream stopping marks nobody's Threads view unread.
"""

from __future__ import annotations

from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import RichContentFailed, TurnActivity
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import Item, TurnUpsert

from .slack_fakes import FakeResponse, FakeWebClient

CHANNEL = "C1"
ASKER = "U0ASKER"


def _adapter(client: FakeWebClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._team_id = "T123"
    return adapter


def _sessions(client: FakeWebClient) -> list[dict[str, Any]]:
    return [
        kwargs["json"]
        for method, kwargs in client.api_calls
        if method == "agents.sessions.setStatus"
    ]


def _turn(status: str = "running") -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": "t1", "status": status, "commandId": None}
    )


def _tool() -> Item:
    return Item.model_validate(
        {
            "itemId": "i1",
            "turnId": "t1",
            "revision": 1,
            "kind": "tool-activity",
            "status": "in-progress",
            "title": "Ran pytest",
            "text": "",
            "attachments": [],
            "origin": None,
        }
    )


@pytest.mark.parametrize(
    ("kind", "hosts"),
    [("channel", True), ("group", True), ("im", False), ("mpim", False)],
)
async def test_work_threads_are_everywhere_but_a_dm(kind: str, hosts: bool) -> None:
    adapter = _adapter(FakeWebClient())
    adapter._channel_type_cache[CHANNEL] = kind
    assert await adapter.hosts_work_threads(CHANNEL) is hosts


async def test_a_channel_never_seen_is_looked_up_once() -> None:
    client = FakeWebClient()
    looked_up: list[dict[str, Any]] = []

    async def conversations_info(**kwargs: Any) -> FakeResponse:
        looked_up.append(kwargs)
        return FakeResponse({"channel": {"is_im": True}})

    client.conversations_info = conversations_info  # type: ignore[method-assign]
    adapter = _adapter(client)
    assert await adapter.hosts_work_threads(CHANNEL) is False
    assert await adapter.hosts_work_threads(CHANNEL) is False
    assert len(looked_up) == 1


async def test_a_channel_that_cannot_be_looked_up_keeps_the_askers_thread() -> None:
    client = FakeWebClient()

    async def conversations_info(**kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "channel_not_found"}))

    client.conversations_info = conversations_info  # type: ignore[method-assign]
    assert await _adapter(client).hosts_work_threads(CHANNEL) is False


async def test_a_work_message_is_a_divider_with_a_session_for_the_asker() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    ref = await adapter.open_work_message(
        CHANNEL, "Agent", "Agent is working on this", ASKER
    )
    [posted] = client.posted
    assert ref == f"{CHANNEL}:{client._ts}.0"
    assert posted["channel"] == CHANNEL
    assert "thread_ts" not in posted, "the work message is at the channel root"
    assert posted["blocks"] == [
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": "_Working on it…_"}],
        }
    ]
    assert posted["text"] == "Agent is working on this"
    [session] = _sessions(client)
    assert session["channel_id"] == CHANNEL
    assert session["thread_ts"] == ref.split(":", 1)[1]
    assert session["status"] == "processing"
    assert session["initiator_user_id"] == ASKER


async def test_a_session_slack_refuses_does_not_stop_the_work_message() -> None:
    client = FakeWebClient()

    async def api_call(method: str, **kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "feature_disabled"}))

    client.api_call = api_call  # type: ignore[method-assign]
    ref = await _adapter(client).open_work_message(CHANNEL, "Agent", "working", ASKER)
    assert ref.startswith(f"{CHANNEL}:")
    assert len(client.posted) == 1


async def test_a_work_message_slack_refuses_is_reported() -> None:
    client = FakeWebClient()

    async def chat_postMessage(**kwargs: Any) -> FakeResponse:
        raise SlackApiError("no", FakeResponse({"error": "not_in_channel"}))

    client.chat_postMessage = chat_postMessage  # type: ignore[method-assign]
    with pytest.raises(RichContentFailed):
        await _adapter(client).open_work_message(CHANNEL, "Agent", "working", ASKER)
    assert _sessions(client) == []


async def test_settling_edits_in_the_last_line_renames_and_ends_the_session() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.settle_work_message(CHANNEL, "Agent", f"{CHANNEL}:5.0", "Work log")
    [edit] = client.updated
    assert (edit["channel"], edit["ts"]) == (CHANNEL, "5.0")
    assert edit["text"] == "Work log"
    assert edit["blocks"] == [
        {"type": "context", "elements": [{"type": "mrkdwn", "text": "_Work log_"}]}
    ]
    calls = [
        (method, kwargs["json"])
        for method, kwargs in client.api_calls
        if method.startswith("agents.sessions.")
    ]
    assert calls == [
        (
            "agents.sessions.rename",
            {"channel_id": CHANNEL, "thread_ts": "5.0", "title": "Agent · Work log"},
        ),
        (
            "agents.sessions.setStatus",
            {"channel_id": CHANNEL, "thread_ts": "5.0", "status": "active"},
        ),
    ]


async def test_a_stream_in_a_thread_nobody_spoke_in_goes_to_whoever_the_turn_answers() -> (
    None
):
    """A work thread, or any thread after a restart emptied the memory of who
    spoke there: still a stream, which is silent, not an ordinary post."""
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._channel_type_cache[CHANNEL] = "channel"
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER),
        f"{CHANNEL}:9.0",
    )
    [started] = client.started
    assert started["recipient_user_id"] == ASKER
    assert started["thread_ts"] == "9.0"
    assert client.posted == []


async def test_the_person_seen_in_the_thread_wins_over_the_turns_asker() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._thread_requester[(CHANNEL, "9.0")] = "U0SEEN"
    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool()], _turn(), recipient_external_id=ASKER),
        f"{CHANNEL}:9.0",
    )
    assert client.started[0]["recipient_user_id"] == "U0SEEN"


async def test_a_turn_with_nobody_to_address_is_still_an_ordinary_post() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool()], _turn()), f"{CHANNEL}:9.0"
    )
    assert client.started == []
    assert len(client.posted) == 1
