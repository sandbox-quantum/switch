"""A turn's activity, streamed into one Slack message instead of edited into it.

An edit replaces a message's whole blocks array, and the client redraws the
`plan` block from scratch — which closes a section the reader had expanded.
That is why the clock used to live in a message of its own: at one redraw every
five seconds, anything open collapsed before it could be read.

`chat.appendStream` does not replace the message. A `plan_update` moves the
header without touching anything under it, and a `blocks` chunk replaces the one
block it names and leaves the rest of the message — and whatever the reader has
open — alone. So the two messages become one, the clock ticks in its header, and
an expanded step stays expanded. Measured against the live API before it was
built, not assumed.

A streamed message is drawn in two ways at once, and the difference is the whole
shape of this. The stream's own plan is addressed with chunks and can only ever
be added to — a card cannot be taken back, and `details` on a `task_update`
*appends* to what the card already holds rather than replacing it. So that plan
carries the status line and one card that is sent once, and nothing that grows.
The steps live in ordinary `plan` blocks carried inside the stream, addressed by
`block_id` and replaced whole, so they can hold a different fifty than they held
a minute ago. Three of those blocks rotate — a line saying what is no longer
shown, then the newest two pages — and a turn of any length draws the same four.

What these cover is the adapter's half: that it opens a stream where it can,
sends only what moved, discloses what it had to leave out, stops at the end of
the turn, and falls back visibly to an ordinary post everywhere else.
"""

from __future__ import annotations

import logging
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
from switch_core.deeplinks import deeplink_for_platform
from switch_core.sessions.contract import Item, TurnUpsert
from switch_core.sessions.presentation import session_console_url

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
    """Every `task_update` sent: the stream's own plan, which is the status."""
    return [
        chunk
        for call in client.appended
        for chunk in call["chunks"]
        if chunk["type"] == "task_update"
    ]


def _drawn(client: FakeWebClient) -> dict[str, dict[str, Any]]:
    """The last block written to each block id, in the order the ids appeared.

    Slack keeps a block where it was first written, so insertion order here is
    the order a reader sees them down the message.
    """
    drawn: dict[str, dict[str, Any]] = {}
    for call in client.appended:
        for chunk in call["chunks"]:
            if chunk["type"] == "blocks":
                for block in chunk["blocks"]:
                    drawn[block["block_id"]] = block
    return drawn


def _pages(client: FakeWebClient) -> list[dict[str, Any]]:
    """The step pages the message is currently showing, oldest first."""
    return [block for block in _drawn(client).values() if block["type"] == "plan"]


def _steps(client: FakeWebClient) -> list[dict[str, Any]]:
    """Every step card the message is currently showing, oldest first."""
    return [task for page in _pages(client) for task in page["tasks"]]


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


async def test_only_the_header_and_the_pages_that_moved_are_appended() -> None:
    """The whole point of a stream over an edit.

    An edit replaces the message's whole blocks array; an append replaces the
    one block it names. The header moves on its own, the page of steps is
    rewritten whole, and the session card goes out once and never again.
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

    opened = _chunks(client)[0]
    assert [c["type"] for c in opened] == ["plan_update", "task_update", "blocks"]
    later = _chunks(client)[1]
    assert [c["type"] for c in later] == ["plan_update", "blocks"]
    assert later[0]["title"] == "Working… 9s · Running: Grep"
    assert [(t["title"], t["status"]) for t in later[1]["blocks"][0]["tasks"]] == [
        ("Read", "complete"),
        ("Grep", "in_progress"),
    ]


async def test_a_blocks_chunk_never_carries_more_than_one_plan() -> None:
    """Measured, not read: Slack refuses a `blocks` chunk holding two plan
    blocks and takes the whole append with it. Several such chunks in one
    append are fine, which is how both pages move together."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(51)]

    await adapter.post_rich(CHANNEL, "Agent", TurnActivity(many, _turn()), THREAD)

    sent = [c for c in _chunks(client)[0] if c["type"] == "blocks"]
    assert len(sent) == 2
    assert all(len(chunk["blocks"]) == 1 for chunk in sent)


async def test_a_page_that_did_not_move_is_not_sent_again() -> None:
    """A full page is fifty cards and several kilobytes. Once a step lands in
    one it never moves to another, so a settled page is left where it is."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(50)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    over = [*many, _tool("t50", "Tool 50", status="completed")]
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(over, _turn(), 9.0), THREAD
    )

    later = [c for c in _chunks(client)[1] if c["type"] == "blocks"]
    assert len(later) == 1
    assert later[0]["blocks"][0]["title"] == "Steps 51–51"


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


async def test_a_detail_takes_the_shape_of_the_place_it_is_sent_to() -> None:
    """One field name, two shapes, and Slack rejects the wrong one.

    Measured, not read: `details` on a `task_update` chunk is a plain string and
    the live API refuses every rich_text form of it, while `details` on a
    `task_card` inside a `plan` block requires rich_text and refuses the string.
    The step cards moved from the first to the second, so the shape moved with
    them — and getting it wrong takes down the whole append.
    """
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity(
            [_tool("t1", "Read", status="completed", text="312 lines")],
            _turn(),
            session_url="https://switch.example/session",
        ),
        THREAD,
    )

    assert _cards(client)[0]["details"] == (
        "<https://switch.example/session|Open in Console app>"
    )
    assert _steps(client)[0]["details"]["type"] == "rich_text"
    assert _steps(client)[0]["details"]["elements"][0]["elements"][0] == {
        "type": "text",
        "text": "312 lines",
    }


@pytest.mark.parametrize("renders_custom_schemes", [True, False])
async def test_a_real_console_link_arrives_whole(renders_custom_schemes: bool) -> None:
    """Built by the code that builds it in production, not by hand.

    Both forms of the link run past two hundred characters — the raw
    `switchdash://` one and the gateway redirect Slack gets instead, because
    Slack will not render a custom scheme. A hand-written short url in a test
    proves nothing about either. The whole url has to be in the card: a link cut
    to fit goes somewhere that is not the session, or nowhere at all.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    url = deeplink_for_platform(
        session_console_url(
            "https://switch.example",
            "3f2b8c1e-5d47-4a19-9b6e-0c8a21d4f7b3",
            "6e927fce-ef10-4248-afaa-34f660cd815d",
            "a91c4d02-7e35-4f68-b2a1-8d5c93e07f4a",
        ),
        "https://switch.example/gateway",
        renders_custom_schemes,
    )
    assert url is not None and len(url) > 150

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool("t1", "Read")], _turn(), session_url=url),
        THREAD,
    )

    assert _cards(client)[0]["details"] == f"<{url}|Open in Console app>"


async def test_the_console_link_goes_out_once() -> None:
    """`details` on a `task_update` appends to what the card already holds
    rather than replacing it, so a card re-sent with the same link shows the
    link twice — and again on every redraw after that."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    url = "https://switch.example/session"

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0, session_url=url), THREAD
    )
    for elapsed in (10.0, 20.0, 30.0):
        await adapter.update_rich(
            CHANNEL,
            "Agent",
            ref,
            TurnActivity([tool], _turn(), elapsed, session_url=url),
            THREAD,
        )

    assert [card["details"] for card in _cards(client)] == [
        f"<{url}|Open in Console app>"
    ]


async def test_a_link_that_only_turns_up_later_is_still_sent() -> None:
    """Appending to a card that has no detail yet leaves just the link, so the
    one card the stream owns is not spent before the session url arrives."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    url = "https://switch.example/session"

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity([tool], _turn(), 9.0, session_url=url),
        THREAD,
    )

    assert [card.get("details") for card in _cards(client)] == [
        None,
        f"<{url}|Open in Console app>",
    ]


async def test_a_redraw_without_the_link_does_not_make_the_stream_forget_it() -> None:
    """What the stream remembers is what Slack was sent, not what was last drawn.

    A publish can arrive without the session url — the clock ticks on whatever
    the caller happens to hold. Remembering that empty card as though it had
    been sent loses the fact that the link already went out, and the next
    publish appends the same link to a card that is already carrying it.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    url = "https://switch.example/session"

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0, session_url=url), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 9.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity([tool], _turn(), 14.0, session_url=url),
        THREAD,
    )

    assert [card["details"] for card in _cards(client)] == [
        f"<{url}|Open in Console app>"
    ]


# ── Paging ───────────────────────────────────────────────────────────────────


async def test_a_turn_of_any_length_draws_the_same_three_step_blocks() -> None:
    """Slack keeps a block where it was first written and has no call that
    removes one, so a block per fifty steps would grow the message without
    bound. Rotating a disclosure line and the newest two pages through a fixed
    three ids keeps both the length and the order of the message fixed however
    long the turn runs.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(240)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many[:1], _turn(), 1.0), THREAD
    )
    for size in range(2, len(many) + 1, 7):
        await adapter.update_rich(
            CHANNEL,
            "Agent",
            ref,
            TurnActivity(many[:size], _turn(), float(size)),
            THREAD,
        )

    gone, older, newer = _drawn(client).values()
    assert gone["elements"][0]["text"] == "_Steps 1–150 no longer shown_"
    assert older["title"] == "Steps 151–200"
    assert [task["title"] for task in older["tasks"]][:1] == ["Tool 150"]
    assert newer["title"] == "Steps 201–240"
    assert [task["title"] for task in newer["tasks"]][-1:] == ["Tool 239"]


async def test_what_is_no_longer_shown_is_one_line_above_the_steps() -> None:
    """One cumulative line naming the whole missing range, not a count tucked
    into the title of a section.

    It is above the steps because it has to be created before them: Slack fixes
    a block where it was first written, so a line added later would describe the
    pages from underneath them. That is why the top block starts as the first
    page of steps and is replaced in place — same id, same position — by the
    line once there is something to disclose.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(101)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many[:100], _turn(), 1.0), THREAD
    )
    before = list(_drawn(client).values())
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn(), 9.0), THREAD
    )

    assert [block["title"] for block in before] == ["Steps 1–50", "Steps 51–100"]
    after = list(_drawn(client).values())
    assert [block["type"] for block in after] == ["context", "plan", "plan"]
    assert after[0]["block_id"] == before[0]["block_id"]
    assert after[0]["elements"][0]["text"] == "_Steps 1–50 no longer shown_"
    assert [block["title"] for block in after[1:]] == ["Steps 51–100", "Steps 101–101"]


async def test_a_step_never_moves_between_pages_once_it_has_landed() -> None:
    """Pages are cut on fixed boundaries — the first fifty, the next fifty —
    rather than as a window on the newest hundred. A window would shuffle every
    card down one on every step, which is a redraw of both blocks each time and
    a card that is not the one the reader opened."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(120)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many[:51], _turn(), 1.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many[:52], _turn(), 9.0), THREAD
    )

    moved = [c for c in _chunks(client)[1] if c["type"] == "blocks"]
    assert [chunk["blocks"][0]["title"] for chunk in moved] == ["Steps 51–52"]
    older, newer = _pages(client)
    assert [task["title"] for task in older["tasks"]][:1] == ["Tool 0"]
    assert [task["title"] for task in newer["tasks"]] == ["Tool 50", "Tool 51"]


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

    last = _steps(client)[-1]
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
        ["plan_update", "task_update", "blocks"],
        ["plan_update"],
        ["plan_update", "blocks"],
    ]
