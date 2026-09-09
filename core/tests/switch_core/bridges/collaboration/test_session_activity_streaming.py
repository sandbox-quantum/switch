"""A turn's activity as a Slack stream, with the tool calls as its timeline.

The posted Block Kit message renders every step inline, which is the whole of
what a reader gets: no way to collapse the eleven file reads and see the two
sentences that matter. Slack's streaming API draws `task_update` chunks as a
timeline it collapses by default, so this routes a turn onto that where it can
and keeps the posted message for where it cannot.

Three things had to be true for the timeline to accumulate rather than
overwrite itself, and each is a test here: every task chunk carries the
contract item's **own** id, so Slack merges an update into the card it belongs
to rather than replacing the one card; the stream is **not deleted** when the
turn ends, because a record of what a turn did is worth reading afterwards; and
the runtime-state path, which drives its own stream on the same thread, stands
down for a thread this one owns.

What is tested against the fake is what was sent to Slack, not what Slack drew
with it: the chunk ids, the statuses, the 256-character cap, and which of
`chat.startStream` / `chat.appendStream` / `chat.stopStream` / `chat.delete`
were called.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from switch_core.bridges.collaboration.session.contract import Item, TurnUpsert
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

from .test_slack_agent_sessions import FakeWebClient

CHANNEL = "C1"
THREAD = "111.0"
TRIGGER = f"{CHANNEL}:{THREAD}"
SESSION = "session-streamed"
TURN = "turn-streamed"


def _adapter(client: FakeWebClient, *, streamable: bool = True) -> SlackAdapter:
    """An adapter Slack will stream for, or one it will not.

    A stream into a channel is a reply to somebody, so it needs the thread, the
    person recorded on it, and the workspace's own id. `streamable=False` is a
    channel nobody has spoken in: everything else is the same, and the turn
    falls back to the posted message.
    """
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._channel_type_cache[CHANNEL] = "channel"
    if streamable:
        adapter._team_id = "T02TEAM"
        adapter._thread_requester[(CHANNEL, THREAD)] = "U1"
    return adapter


def _turn(status: str, turn_id: str = TURN) -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": turn_id, "status": status, "commandId": None}
    )


def _item(
    item_id: str,
    *,
    kind: str = "tool-activity",
    status: str = "in-progress",
    title: str = "Read `adapter.py`",
    text: str = "",
) -> Item:
    return Item.model_validate(
        {
            "itemId": item_id,
            "turnId": TURN,
            "revision": 1,
            "kind": kind,
            "status": status,
            "title": title,
            "text": text,
            "attachments": [],
            "origin": None,
            "audience": {"kind": "session-members"},
        }
    )


async def _publish(
    activity: SessionTurnActivity,
    items: list[Item],
    turn: TurnUpsert,
    *,
    thread_root_id: str | None = TRIGGER,
) -> None:
    await activity.publish(
        items,
        turn,
        session_id=SESSION,
        channel_id=CHANNEL,
        thread_root_id=thread_root_id,
        agent_name="agent-demo",
    )


def _methods(client: FakeWebClient) -> list[str]:
    return [method for method, _ in client.api_calls]


def _appended(client: FakeWebClient) -> list[dict[str, Any]]:
    """Every chunk sent to the stream, flattened, in the order they were sent."""
    return [
        chunk
        for method, payload in client.api_calls
        if method == "chat.appendStream"
        for chunk in payload["chunks"]
    ]


def _tasks(client: FakeWebClient) -> list[dict[str, Any]]:
    return [c for c in _appended(client) if c["type"] == "task_update"]


# ── Which way the turn is drawn ──────────────────────────────────────────────


async def test_a_threaded_turn_is_streamed_rather_than_posted() -> None:
    """The slice, in one test: nothing is posted, the timeline is."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item("call-1")], _turn("running"))

    assert client.posted == []
    assert _methods(client) == ["chat.startStream", "chat.appendStream"]
    start = client.api_calls[0][1]
    assert start["channel"] == CHANNEL
    assert start["thread_ts"] == THREAD
    assert start["recipient_user_id"] == "U1"
    assert start["task_display_mode"] == "timeline"


async def test_a_turn_slack_will_not_stream_falls_back_to_the_posted_message() -> None:
    """Not a degraded mode: it is what a channel with no thread gets.

    And what every platform that is not Slack gets, which is why the posted
    renderer stays rather than being replaced by this.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client, streamable=False))

    await _publish(activity, [_item("call-1")], _turn("running"), thread_root_id=None)

    assert _methods(client) == []
    assert len(client.posted) == 1


async def test_a_thread_with_nobody_recorded_on_it_is_posted_instead() -> None:
    """Streaming into a channel is addressed to a person, so it needs one."""
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._thread_requester.pop((CHANNEL, THREAD))
    activity = SessionTurnActivity(adapter)

    await _publish(activity, [_item("call-1")], _turn("running"))

    assert _methods(client) == []
    assert len(client.posted) == 1


# ── The timeline accumulates ─────────────────────────────────────────────────


async def test_each_tool_call_is_its_own_card_under_its_own_id() -> None:
    """The first of the three: without this the timeline is one card.

    Slack merges a `task_update` into the card already carrying its id, so a
    fixed id makes every step overwrite the last and the reader is left with
    whatever the turn did most recently and no record of the rest.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    calls = [_item("call-1"), _item("call-2", title="Run the tests")]

    await _publish(activity, calls[:1], _turn("running"))
    await _publish(activity, calls, _turn("running"))

    assert [task["id"] for task in _tasks(client)] == ["call-1", "call-2"]
    assert [task["title"] for task in _tasks(client)] == [
        "Read adapter.py",
        "Run the tests",
    ]


async def test_a_tool_call_that_finishes_moves_its_own_card() -> None:
    """The same id again, which is what makes it an update and not a second step."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(activity, [_item("call-1")], _turn("running"))
    await _publish(activity, [_item("call-1", status="completed")], _turn("running"))

    assert [(t["id"], t["status"]) for t in _tasks(client)] == [
        ("call-1", "in_progress"),
        ("call-1", "complete"),
    ]


async def test_an_unchanged_tool_call_is_not_sent_again() -> None:
    """A turn is republished on every change, and most items did not change."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    first = _item("call-1", status="completed")

    await _publish(activity, [first], _turn("running"))
    await _publish(activity, [first, _item("call-2")], _turn("running"))

    assert [task["id"] for task in _tasks(client)] == ["call-1", "call-2"]


async def test_a_tool_call_title_carries_no_markup() -> None:
    """A task title is plain text, so markup arrives as literal characters."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))

    await _publish(
        activity, [_item("call-1", title="Read **all** `of` it")], _turn("running")
    )

    assert _tasks(client)[0]["title"] == "Read all of it"


# ── What Slack will take ─────────────────────────────────────────────────────


async def test_an_oversized_task_chunk_is_trimmed_to_fit() -> None:
    """Slack rejects the whole append over 256 characters, steps and all.

    So one long tool title would cost every step sent with it, not just itself.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    long_one = _item("call-1", title="Read " + "x" * 400, text="y" * 400)

    await _publish(activity, [long_one, _item("call-2")], _turn("running"))

    chunk = _tasks(client)[0]
    assert len(json.dumps(chunk, ensure_ascii=False)) <= 256
    assert [task["id"] for task in _tasks(client)] == ["call-1", "call-2"]


async def test_an_over_long_item_id_becomes_a_stable_short_one() -> None:
    """Hashed rather than cut: two ids sharing a prefix would share a card."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    prefix = "call-" + "z" * 80

    await _publish(
        activity, [_item(f"{prefix}-one"), _item(f"{prefix}-two")], _turn("running")
    )

    ids = [task["id"] for task in _tasks(client)]
    assert all(len(task_id) <= 64 for task_id in ids)
    assert len(set(ids)) == 2


# ── What a stream cannot take back ───────────────────────────────────────────


async def test_a_message_is_held_back_until_it_has_finished() -> None:
    """A half-written paragraph appended now can never be corrected."""
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    said = _item("say-1", kind="assistant-message", title="", text="Half a th")

    await _publish(activity, [said], _turn("running"))
    finished = _item(
        "say-1",
        kind="assistant-message",
        status="completed",
        title="",
        text="Half a thought.",
    )
    await _publish(activity, [finished], _turn("running"))

    texts = [c["text"] for c in _appended(client) if c["type"] == "markdown_text"]
    assert texts == ["Half a thought.\n\n"]


async def test_a_message_revised_after_it_was_streamed_says_so_and_stands(
    caplog: Any,
) -> None:
    """A stream can move a card but it cannot unsay a sentence.

    Appending the correction would leave both on screen, so the earlier text
    stands and the mismatch is logged rather than papered over.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    said = _item(
        "say-1", kind="assistant-message", status="completed", title="", text="First."
    )
    await _publish(activity, [said], _turn("running"))

    revised = _item(
        "say-1", kind="assistant-message", status="completed", title="", text="Second."
    )
    with caplog.at_level(logging.WARNING):
        await _publish(activity, [revised], _turn("running"))
        await _publish(activity, [revised], _turn("running"))

    assert "cannot unsay what it has said" in caplog.text
    assert caplog.text.count("cannot unsay what it has said") == 1
    texts = [c["text"] for c in _appended(client) if c["type"] == "markdown_text"]
    assert texts == ["First.\n\n"]


async def test_an_append_slack_refused_is_sent_again_with_the_next_change() -> None:
    """Nothing counts as sent until Slack has taken it.

    The alternative is a stream that silently skips a step; this one is a step
    behind and catches up.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    await _publish(activity, [_item("call-1")], _turn("running"))

    client.stream_error = "ratelimited"
    await _publish(activity, [_item("call-1", status="completed")], _turn("running"))
    client.stream_error = None
    await _publish(activity, [_item("call-1", status="completed")], _turn("running"))

    assert [(t["id"], t["status"]) for t in _tasks(client)] == [
        ("call-1", "in_progress"),
        ("call-1", "complete"),
    ]


# ── The end of the turn ──────────────────────────────────────────────────────


async def test_the_stream_is_stopped_and_left_where_it_is() -> None:
    """The second of the three. The runtime-state card is deleted here.

    That one is an indicator and has nothing to say once the turn is over;
    this is the record of what the turn did, which is worth as much after.
    """
    client = FakeWebClient()
    activity = SessionTurnActivity(_adapter(client))
    await _publish(activity, [_item("call-1")], _turn("running"))

    await _publish(activity, [_item("call-1", status="completed")], _turn("completed"))

    assert "chat.stopStream" in _methods(client)
    assert client.deleted == []
    assert _appended(client)[-1] == {
        "type": "markdown_text",
        "text": "_Turn complete._",
    }


async def test_a_turn_that_ended_releases_the_thread_for_the_next_one() -> None:
    """One stream per thread, so a stopped one must not keep holding it."""
    client = FakeWebClient()
    adapter = _adapter(client)
    activity = SessionTurnActivity(adapter)

    await _publish(activity, [_item("call-1")], _turn("completed"))

    assert adapter._activity_streams == {}


# ── The runtime-state path stands down ───────────────────────────────────────


async def test_the_runtime_state_card_leaves_a_streamed_thread_alone() -> None:
    """The third of the three, and the reason the two paths do not fight.

    Slack allows one stream per thread. Both drivers key on the same thread, so
    without a precedence rule the runtime-state card appends its own line into
    this timeline and closes the stream when the turn's state changes.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    activity = SessionTurnActivity(adapter)
    await _publish(activity, [_item("call-1")], _turn("running"))
    before = len(client.api_calls)

    await adapter.apply_runtime_state(
        CHANNEL,
        "agent-demo",
        "working",
        mention_handle=None,
        thread_root_id=TRIGGER,
        detail="Reading files",
        deeplink_url=None,
    )

    assert client.api_calls[before:] == []
    assert client.posted == []
