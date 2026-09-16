"""A turn's activity, streamed into one Slack message instead of edited into it.

An edit replaces a message's whole blocks array, and the client redraws the
`plan` block from scratch — which closes a section the reader had expanded.
That is why the clock used to live in a message of its own: at one redraw every
five seconds, anything open collapsed before it could be read.

`chat.appendStream` does not replace anything. A `task_update` carrying an id
Slack already holds merges into that card, and a `plan_update` moves the header
without touching the cards at all. So the two messages become one, the clock
ticks in its header, and an expanded step stays expanded. Measured against the
live API before it was built, not assumed.

What these cover is the adapter's half: that it opens a stream where it can,
sends only what moved, discloses what it had to leave out, stops at the end of
the turn, and falls back visibly to an ordinary post everywhere else.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import (
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.session.outbound import SessionTurnActivity
from switch_core.bridges.collaboration.slack.adapter import (
    _MAX_OPEN_STREAMS,
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import Item, TurnUpsert

from .slack_fakes import FakeResponse, FakeWebClient

CHANNEL = "C1"
THREAD = "C1:root"
ASKER = "U0ASKER"
TURN = "turn-1"


def _adapter(client: FakeWebClient) -> SlackAdapter:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )
    adapter._web_client = client  # type: ignore[assignment]
    adapter._team_id = "T123"
    adapter._channel_type_cache[CHANNEL] = "channel"
    adapter._thread_requester[(CHANNEL, "root")] = ASKER
    return adapter


def _turn(status: str = "running") -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": TURN, "status": status, "commandId": None}
    )


def _tool(
    item_id: str, title: str, status: str = "in-progress", text: str = ""
) -> Item:
    return Item.model_validate(
        {
            "itemId": item_id,
            "turnId": TURN,
            "revision": 1,
            "kind": "tool-activity",
            "status": status,
            "title": title,
            "text": text,
            "attachments": [],
            "origin": None,
        }
    )


def _chunks(client: FakeWebClient) -> list[list[dict[str, Any]]]:
    return [call["chunks"] for call in client.appended]


def _cards(client: FakeWebClient) -> list[dict[str, Any]]:
    return [
        chunk
        for call in client.appended
        for chunk in call["chunks"]
        if chunk["type"] == "task_update"
    ]


# ── Opening ──────────────────────────────────────────────────────────────────


async def test_a_turn_in_a_thread_with_an_asker_opens_a_plan_mode_stream() -> None:
    """Everything the stream needs is on the call that opens it.

    `task_display_mode` is what makes this a plan rather than a timeline, and
    the recipient pair is what Slack requires to stream into a channel at all —
    without either, the message is not the one this change is for.
    """
    client = FakeWebClient()
    adapter = _adapter(client)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool("t1", "Read")], _turn()), THREAD
    )

    assert client.posted == []
    assert ref == f"{CHANNEL}:1.0"
    opened = client.started[0]
    assert opened["channel"] == CHANNEL
    assert opened["thread_ts"] == "root"
    assert opened["task_display_mode"] == "plan"
    assert opened["recipient_user_id"] == ASKER
    assert opened["recipient_team_id"] == "T123"


async def test_the_asker_is_whoever_last_spoke_in_the_thread_and_not_a_bot() -> None:
    """A stream has to be addressed to somebody, and it should be the person
    waiting on the answer rather than the agent that answered last."""
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )

    adapter._note_requester(CHANNEL, "root", "root", ASKER, None)
    adapter._note_requester(CHANNEL, "reply", "root", None, "B0BOT")

    assert adapter._requester_for(THREAD) == ASKER


# ── Sending only what moved ──────────────────────────────────────────────────


async def test_only_the_header_and_the_cards_that_changed_are_appended() -> None:
    """The whole point of a stream over an edit.

    A redraw that re-sent every card would cost what an edit costs and lose the
    property it was chosen for, so a card Slack already holds unchanged is not
    sent again.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    first, second = _tool("t1", "Read"), _tool("t2", "Grep")

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([first], _turn(), 1.0), THREAD
    )
    done = first.model_copy(update={"revision": 2, "status": "completed"})
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([done, second], _turn(), 9.0), THREAD
    )

    assert [c["type"] for c in _chunks(client)[0]] == ["plan_update", "task_update"]
    later = _chunks(client)[1]
    assert [c["type"] for c in later] == ["plan_update", "task_update", "task_update"]
    assert later[0]["title"] == "Working… 9s · Running: Grep"
    assert (later[1]["title"], later[1]["status"]) == ("Read", "complete")
    assert (later[2]["title"], later[2]["status"]) == ("Grep", "in_progress")


async def test_a_publish_that_changed_nothing_appends_nothing() -> None:
    """The clock ticks every five seconds whether or not anything happened."""
    client = FakeWebClient()
    adapter = _adapter(client)
    content = TurnActivity([_tool("t1", "Read")], _turn(), 4.0)

    ref = await adapter.post_rich(CHANNEL, "Agent", content, THREAD)
    await adapter.update_rich(CHANNEL, "Agent", ref, content, THREAD)

    assert len(client.appended) == 1


async def test_the_clock_moves_the_header_without_resending_a_card() -> None:
    """What the second message existed to buy, bought inside the first."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 5.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 10.0), THREAD
    )

    assert _chunks(client)[1] == [
        {"type": "plan_update", "title": "Working… 10s · Running: Read"}
    ]


async def test_a_card_carries_its_detail_as_a_plain_string() -> None:
    """Measured, not read: the live API rejects every rich_text shape here,
    though the `task_card` block of the same name requires one."""
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity(
            [_tool("t1", "Read", status="completed", text="312 lines")], _turn()
        ),
        THREAD,
    )

    assert _cards(client)[0]["details"] == "312 lines"


async def test_no_chunk_exceeds_what_an_append_will_carry() -> None:
    """Slack measures a chunk serialised and rejects the append over 256
    characters, taking every other chunk in it down with it. The title is what
    survives: a card whose detail was cut still says what it did."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "R" * 400, status="completed", text="D" * 400)

    await adapter.post_rich(CHANNEL, "Agent", TurnActivity([tool], _turn()), THREAD)

    card = _cards(client)[0]
    assert len(json.dumps(card, separators=(",", ":"))) <= 256
    assert card["title"].startswith("RRR")
    assert "details" not in card


async def test_a_trim_never_leaves_half_an_escaped_character_on_screen() -> None:
    """The value being cut has already been escaped, so a blind slice can leave
    `&am` in front of the reader instead of an `&`."""
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool("t1", "&" * 200, status="completed")], _turn()),
        THREAD,
    )

    title = _cards(client)[0]["title"]
    assert title.endswith("…")
    assert re.fullmatch(r"(&amp;)+", title[:-1])


async def test_the_console_link_goes_out_once(caplog: Any) -> None:
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    url = "https://switch.example/session"

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0, session_url=url), THREAD
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity([tool], _turn(), 20.0, session_url=url),
        THREAD,
    )

    links = [
        chunk
        for call in client.appended
        for chunk in call["chunks"]
        if chunk["type"] == "markdown_text"
    ]
    assert len(links) == 1
    assert url in links[0]["text"]


# ── The cap ──────────────────────────────────────────────────────────────────


async def test_cards_past_the_cap_are_left_out_and_the_header_says_so() -> None:
    """A stream cannot take a card back, so the cap is on cards ever created.

    The posted plan drops its oldest and keeps a window on the newest; this
    cannot, so it keeps the oldest and says how many it could not open. Either
    way the reader is told the log is not complete.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(53)]

    await adapter.post_rich(CHANNEL, "Agent", TurnActivity(many, _turn()), THREAD)

    assert len(_cards(client)) == 50
    assert "3 earlier steps not shown" in _chunks(client)[0][0]["title"]


# ── Ending ───────────────────────────────────────────────────────────────────


async def test_a_finished_turn_stops_the_stream_and_leaves_the_message() -> None:
    """Unlike Slack's own progress card there is nothing here to delete: the
    plan is the record of what the turn did."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    done = tool.model_copy(update={"revision": 2, "status": "completed"})
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([done], _turn("completed"), 30.0), THREAD
    )

    assert client.stopped == [{"channel": CHANNEL, "ts": "1.0"}]
    assert client.deleted == []
    assert _chunks(client)[-1][0]["title"] == "Worked for 30s. 1 tool call."


async def test_an_unfinished_step_is_named_rather_than_left_spinning() -> None:
    """A turn can stop with a call still open, and nothing will ever close it."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn()), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("interrupted"), 4.0), THREAD
    )

    last = _cards(client)[-1]
    assert last["status"] == "complete"
    assert last["title"] == "Unfinished: Read"


async def test_the_stream_is_forgotten_once_it_is_stopped() -> None:
    """A second turn in the same thread opens its own stream rather than
    appending to the one the last turn left behind."""
    client = FakeWebClient()
    adapter = _adapter(client)

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool("t1", "Read")], _turn()), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([], _turn("completed"), 1.0), THREAD
    )

    assert adapter._streams == {}


async def test_turns_that_never_end_do_not_pile_up_forever(caplog: Any) -> None:
    """Only a turn ending closes a stream, and a turn whose agent died never
    ends. The oldest is dropped rather than held for the life of the process."""
    client = FakeWebClient()
    adapter = _adapter(client)
    adapter._thread_requester[(CHANNEL, "root")] = ASKER

    refs = []
    with caplog.at_level(logging.WARNING):
        for index in range(_MAX_OPEN_STREAMS + 1):
            ref = await adapter.post_rich(
                CHANNEL,
                "Agent",
                TurnActivity([_tool(f"t{index}", "Read")], _turn()),
                THREAD,
            )
            refs.append(ref)

    assert len(adapter._streams) == _MAX_OPEN_STREAMS
    assert refs[0] not in adapter._streams
    assert refs[-1] in adapter._streams
    assert "Forgetting the activity stream" in caplog.text


# ── When Slack will not stream ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "break_it, missing",
    [
        (lambda a: a._thread_requester.clear(), "nobody in the thread"),
        (lambda a: setattr(a, "_team_id", ""), "workspace id is unknown"),
    ],
)
async def test_a_turn_that_cannot_stream_is_posted_and_the_reason_logged(
    break_it: Any, missing: str, caplog: Any
) -> None:
    """Degraded, not broken: the turn still appears, and its plan still
    collapses on every redraw. An operator should be able to see which."""
    client = FakeWebClient()
    adapter = _adapter(client)
    break_it(adapter)

    with caplog.at_level(logging.WARNING):
        ref = await adapter.post_rich(
            CHANNEL, "Agent", TurnActivity([_tool("t1", "Read")], _turn()), THREAD
        )

    assert client.started == []
    assert len(client.posted) == 1
    assert client.posted[0]["blocks"][0]["type"] == "plan"
    assert ref == f"{CHANNEL}:1.0"
    assert missing in caplog.text


async def test_a_turn_outside_a_thread_is_posted_rather_than_streamed() -> None:
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool("t1", "Read")], _turn()), None
    )

    assert client.started == []
    assert len(client.posted) == 1


async def test_slack_refusing_to_open_a_stream_falls_back_to_a_post(
    caplog: Any,
) -> None:
    """Every reason Slack declines leaves the ordinary post working, so the
    publication is drawn rather than failed."""
    client = FakeWebClient()
    adapter = _adapter(client)
    client.start_error = "not_an_agent"

    with caplog.at_level(logging.WARNING):
        ref = await adapter.post_rich(
            CHANNEL, "Agent", TurnActivity([_tool("t1", "Read")], _turn()), THREAD
        )

    assert ref == f"{CHANNEL}:1.0"
    assert len(client.posted) == 1
    assert "not_an_agent" in caplog.text


async def test_an_attention_post_is_never_streamed() -> None:
    """One stream per thread, and the attention reply is a message of its own."""
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([], _turn("error"), status_only=True, error_summary="Offline."),
        THREAD,
    )

    assert client.started == []
    assert len(client.posted) == 1


# ── When an append is refused ────────────────────────────────────────────────


async def test_a_closed_stream_is_forgotten_so_later_updates_are_edits(
    caplog: Any,
) -> None:
    """A stopped stream, or one this app no longer owns, is gone rather than
    temporarily unwell. The message is still there, so the turn goes on being
    drawn — as an ordinary edit, collapsing and all."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )

    client.append_error = "stopped_by_user"
    with pytest.raises(RichContentFailed), caplog.at_level(logging.WARNING):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 9.0), THREAD
        )
    client.append_error = None
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 14.0), THREAD
    )

    assert "stopped_by_user" in caplog.text
    assert adapter._streams == {}
    assert [call["ts"] for call in client.updated] == ["1.0"]


async def test_a_throttled_append_asks_the_caller_to_wait_and_keeps_the_stream(
    monkeypatch: Any,
) -> None:
    """Rate limiting is temporary, so the stream survives it — and the chunks
    that were refused are still owed, not marked as sent."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )

    async def refuse(**kwargs: Any) -> None:
        raise SlackApiError(
            "no",
            FakeResponse({"error": "ratelimited"}, headers={"Retry-After": "7"}),
        )

    monkeypatch.setattr(client, "chat_appendStream", refuse)
    with pytest.raises(RichContentThrottled) as refused:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 9.0), THREAD
        )

    assert refused.value.retry_after == 7.0
    assert ref in adapter._streams
    assert adapter._streams[ref].title == "Working… 1s · Running: Read"


# ── End to end, through the publisher ────────────────────────────────────────


async def test_a_turn_published_from_start_to_finish_is_one_streamed_message() -> None:
    """What a reader ends up with: one message, opened once, never rebuilt."""
    client = FakeWebClient()
    adapter = _adapter(client)
    activity = SessionTurnActivity(adapter)
    kwargs = dict(
        session_id="session",
        channel_id=CHANNEL,
        thread_root_id=THREAD,
        asked_on=None,
        agent_name="Agent",
    )
    read = _tool("t1", "Read")

    await activity.publish([read], _turn(), elapsed_seconds=0, **kwargs)
    await activity.publish([read], _turn(), elapsed_seconds=5, **kwargs)
    done = read.model_copy(update={"revision": 2, "status": "completed"})
    await activity.publish([done], _turn("completed"), elapsed_seconds=12, **kwargs)

    assert client.posted == []
    assert client.updated == []
    assert len(client.started) == 1
    assert len(client.stopped) == 1
    assert [
        [chunk["type"] for chunk in call["chunks"]] for call in client.appended
    ] == [
        ["plan_update", "task_update"],
        ["plan_update"],
        ["plan_update", "task_update"],
    ]
