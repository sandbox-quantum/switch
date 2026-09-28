"""A turn's activity, streamed into one Slack message instead of edited into it.

An edit replaces a message's whole blocks array, and the client redraws the
`plan` block from scratch — which closes a section the reader had expanded.
That is why the clock used to live in a message of its own: at one redraw every
five seconds, anything open collapsed before it could be read.

`chat.appendStream` does not replace the message. A `blocks` chunk replaces the
one block it names and leaves the rest of the message — and whatever the reader
has open — alone. So the two messages become one, the clock ticks in it, and an
expanded step stays expanded. Measured against the live API before it was built,
not assumed.

The whole turn is drawn in those blocks and in nothing else. A stream can carry
a plan of its own, addressed with chunks, and that is where the status line used
to live — but such a plan can only ever be added to, so it could never hold the
steps, and it cost the message a line above them. Measured: a stream with no
plan chunks at all still draws its blocks, and a plan with no cards in it draws
neither itself nor its title. So the header moved onto the newest section, and
the Console link moved into the first row of every section.

Three blocks rotate — a line saying what is no longer shown, then the newest two
sections — and a turn of any length draws the same three. A section holds
forty-nine of the turn's cards, the fiftieth row being the session card, because
Slack caps a plan block at fifty.

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
    RichContentWedged,
    TurnActivity,
)
from switch_core.bridges.collaboration.slack.adapter import (
    _MAX_OPEN_STREAMS,
    _MAX_WEDGED_MESSAGES,
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
    """The sections the message is currently showing, oldest first."""
    return [block for block in _drawn(client).values() if block["type"] == "plan"]


def _session(page: dict[str, Any]) -> dict[str, Any]:
    """A section's session card, which is the first row of every one of them."""
    card = page["tasks"][0]
    assert card["task_id"] == "switch-session"
    return dict(card)


def _cards(client: FakeWebClient) -> list[dict[str, Any]]:
    """The session card as each section currently holds it, oldest section first."""
    return [_session(page) for page in _pages(client)]


def _steps(client: FakeWebClient) -> list[dict[str, Any]]:
    """Every step card the message is currently showing, oldest first."""
    return [task for page in _pages(client) for task in page["tasks"][1:]]


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


async def test_only_the_sections_that_moved_are_appended() -> None:
    """The whole point of a stream over an edit.

    An edit replaces the message's whole blocks array; an append replaces the
    one block it names. A section is rewritten whole, and a message with one
    section in it is one chunk however much of the turn changed.
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

    assert [c["type"] for c in _chunks(client)[0]] == ["blocks"]
    later = _chunks(client)[1]
    assert [c["type"] for c in later] == ["blocks"]
    assert later[0]["blocks"][0]["title"] == "Working… 9s · Running: Grep"
    assert [(t["title"], t["status"]) for t in later[0]["blocks"][0]["tasks"][1:]] == [
        ("Read", "complete"),
        ("Grep", "in_progress"),
    ]


async def test_a_blocks_chunk_never_carries_more_than_one_plan() -> None:
    """Measured, not read: Slack refuses a `blocks` chunk holding two plan
    blocks and takes the whole append with it. Several such chunks in one
    append are fine, which is how both pages move together."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(50)]

    await adapter.post_rich(CHANNEL, "Agent", TurnActivity(many, _turn()), THREAD)

    sent = [c for c in _chunks(client)[0] if c["type"] == "blocks"]
    assert len(sent) == 2
    assert all(len(chunk["blocks"]) == 1 for chunk in sent)


async def test_a_section_that_did_not_move_is_not_sent_again() -> None:
    """A full section is fifty cards and several kilobytes. Once a step lands in
    one it never moves to another, so a settled section is left where it is."""
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
    assert later[0]["blocks"][0]["title"] == "Working… 9s · Last: Tool 50"


async def test_a_publish_that_changed_nothing_appends_nothing() -> None:
    """The clock ticks every five seconds whether or not anything happened."""
    client = FakeWebClient()
    adapter = _adapter(client)
    content = TurnActivity([_tool("t1", "Read")], _turn(), 4.0)

    ref = await adapter.post_rich(CHANNEL, "Agent", content, THREAD)
    await adapter.update_rich(CHANNEL, "Agent", ref, content, THREAD)

    assert len(client.appended) == 1


async def test_the_clock_moves_the_live_section_and_nothing_above_it() -> None:
    """What the second message existed to buy, bought inside the first.

    The clock is in a block's heading now rather than in a header of its own, so
    a tick rewrites that block — there is no call that moves a block's title on
    its own. What it must not do is disturb a settled section above it, which is
    the one a reader is likely to have open.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(50)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 5.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn(), 10.0), THREAD
    )

    assert [c["blocks"][0]["block_id"] for c in _chunks(client)[1]] == [
        "switch-interrupt"
    ]
    assert _chunks(client)[1][0]["blocks"][0]["title"] == "Working… 10s · Last: Tool 49"


async def test_a_detail_is_rich_text_because_that_is_what_a_card_takes() -> None:
    """One field name, two shapes, and Slack rejects the wrong one.

    Measured, not read: `details` on a `task_update` chunk is a plain string and
    the live API refuses every rich_text form of it, while `details` on a
    `task_card` inside a `plan` block requires rich_text and refuses the string.
    Every card the message holds is now in a block, the session card included,
    so all of them take the second shape — and getting it wrong takes down the
    whole append.
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

    assert _cards(client)[0]["details"]["elements"][0]["elements"][0] == {
        "type": "link",
        "url": "https://switch.example/session",
        "text": "Open in Console app",
    }
    assert _steps(client)[0]["details"]["type"] == "rich_text"
    assert _steps(client)[0]["details"]["elements"][0]["elements"][0] == {
        "type": "text",
        "text": "312 lines",
    }


async def test_the_link_is_the_card_rather_than_a_line_under_a_label() -> None:
    """A row reading "Switch session" above one reading "Open in Console app"
    says the same thing twice.

    The link names what it opens, so the title above it is a row of nothing —
    and it is a row a reader has to look past to reach the one control the
    stream offers them.
    """
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity(
            [_tool("t1", "Read")],
            _turn(),
            session_url="https://switch.example/session",
        ),
        THREAD,
    )

    assert _cards(client)[0]["hide_title"] is True


async def test_the_link_is_in_every_section_rather_than_only_the_first() -> None:
    """A reader opens one section. A link in the other one is a link they have
    to go looking for, and the section they opened is the section they chose."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    url = "https://switch.example/session"

    await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 9.0, session_url=url), THREAD
    )

    assert len(_pages(client)) == 2
    assert [
        card["details"]["elements"][0]["elements"][0]["url"] for card in _cards(client)
    ] == [url, url]


async def test_a_card_with_no_link_in_it_still_says_what_it_is() -> None:
    """Hiding the title is the link earning the row. With no link there is no
    second row to earn it, and a card hiding the only thing it holds is blank —
    in a section that is drawn before the turn has anything else to put in it."""
    client = FakeWebClient()
    adapter = _adapter(client)

    await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool("t1", "Read")], _turn()), THREAD
    )

    card = _cards(client)[0]
    assert "hide_title" not in card
    assert card["title"] == "Switch session"


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

    assert _cards(client)[0]["details"]["elements"][0]["elements"][0]["url"] == url


async def test_the_console_link_is_drawn_once_however_often_it_is_sent() -> None:
    """A block is replaced whole, so a link re-sent is the same link, not a
    second one.

    This is what moving the card out of the stream's own plan bought. `details`
    on a `task_update` chunk *appends* to what the card already holds rather
    than replacing it, so the link had to be tracked and dropped from every
    chunk after the one that carried it, or the card came back holding it twice
    — and again on every redraw after that.
    """
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

    assert len(_cards(client)) == 1
    links = [
        element
        for card in _cards(client)
        for element in card["details"]["elements"][0]["elements"]
    ]
    assert [element["url"] for element in links] == [url]


async def test_a_link_that_only_turns_up_later_is_still_drawn() -> None:
    """The session url is built from configuration and three ids, and a publish
    can be drawn before the code that builds it has them all."""
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

    assert _cards(client)[0]["details"]["elements"][0]["elements"][0]["url"] == url


async def test_the_live_section_spins_while_the_turn_runs_and_settles_with_it() -> None:
    """Slack draws a block's glyph from the cards in it, and between two calls
    every step card in a running turn is settled.

    So the session card carries the turn's state on the live section: sent
    complete it showed a check beside "Working…", which is the one thing the top
    of the message should never say while the turn is still going. On a settled
    section above it the same card is complete, because a spinner there points
    at a place where nothing is happening.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    url = "https://switch.example/session"

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0, session_url=url), THREAD
    )
    running = [card["status"] for card in _cards(client)]
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity(many, _turn("completed"), 9.0, session_url=url),
        THREAD,
    )

    assert running == ["complete", "in_progress"]
    assert [card["status"] for card in _cards(client)] == ["complete", "complete"]


# ── Paging ───────────────────────────────────────────────────────────────────


async def test_a_turn_of_any_length_draws_the_same_three_step_blocks() -> None:
    """Slack keeps a block where it was first written and has no call that
    removes one, so a block per section would grow the message without bound.
    Rotating a disclosure line and the newest two sections through a fixed three
    ids keeps both the length and the order of the message fixed however long
    the turn runs.
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
    assert gone["elements"][0]["text"] == "_Activity 1–147 no longer shown_"
    assert older["title"] == "Activity 148–196"
    assert [task["title"] for task in older["tasks"][1:]][:1] == ["Tool 147"]
    assert newer["title"] == "Working… 4m 0s · Last: Tool 239"
    assert [task["title"] for task in newer["tasks"][1:]][-1:] == ["Tool 239"]


async def test_what_is_no_longer_shown_is_one_line_above_the_sections() -> None:
    """One cumulative line naming the whole missing range, not a count tucked
    into the title of a section — and not there at all until a third section
    has pushed the first one out.

    It is above the sections because it has to be created before them: Slack
    fixes a block where it was first written, so a line added later would
    describe them from underneath. That is why the top block starts as the first
    section and is replaced in place — same id, same position — by the line once
    there is something to disclose.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(99)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many[:98], _turn(), 1.0), THREAD
    )
    before = list(_drawn(client).values())
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn(), 9.0), THREAD
    )

    assert [block["title"] for block in before] == [
        "Activity 1–49",
        "Working… 1s · Last: Tool 97",
    ]
    after = list(_drawn(client).values())
    assert [block["type"] for block in after] == ["context", "plan", "plan"]
    assert after[0]["block_id"] == before[0]["block_id"]
    assert after[0]["elements"][0]["text"] == "_Activity 1–49 no longer shown_"
    assert [block["title"] for block in after[1:]] == [
        "Activity 50–98",
        "Working… 9s · Last: Tool 98",
    ]


async def test_a_step_never_moves_between_sections_once_it_has_landed() -> None:
    """Sections are cut on fixed boundaries — the first forty-nine, the next
    forty-nine — rather than as a window on the newest ninety-eight. A window
    would shuffle every card down one on every step, which is a redraw of both
    blocks each time and a card that is not the one the reader opened."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(120)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many[:50], _turn(), 1.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many[:51], _turn(), 9.0), THREAD
    )

    moved = [c for c in _chunks(client)[1] if c["type"] == "blocks"]
    assert [chunk["blocks"][0]["title"] for chunk in moved] == [
        "Working… 9s · Last: Tool 50"
    ]
    older, newer = _pages(client)
    assert [task["title"] for task in older["tasks"][1:]][:1] == ["Tool 0"]
    assert [task["title"] for task in newer["tasks"][1:]] == ["Tool 49", "Tool 50"]


# ── Where the live step is named ─────────────────────────────────────────────


async def test_the_live_step_is_named_on_its_own_section_and_not_in_the_header() -> (
    None
):
    """Said once, where it is useful.

    A heading is the whole of a collapsed section, so the label belongs on the
    heading of the section actually holding the live step — that is both what is
    running and where to open to watch it. It is not always the newest section:
    the clock sits there, and a step that is still open can be a section behind
    it.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    many[20] = _tool("t20", "Grep")

    await adapter.post_rich(CHANNEL, "Agent", TurnActivity(many, _turn(), 40.0), THREAD)

    assert [page["title"] for page in _pages(client)] == [
        "Activity 1–49 · Running: Grep",
        "Working… 40s",
    ]


async def test_the_label_leaves_a_settled_section_when_the_live_step_moves_past_it() -> (
    None
):
    """A heading saying what is running has to stop saying it once nothing is.

    Crossing a section boundary is the one moment a settled section is
    rewritten, and it is rewritten to drop the label rather than to change its
    steps. Leaving it would put "Last: …" on a section whose last step is no
    longer the turn's, and the reader would open the wrong one.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(50)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many[:49], _turn(), 1.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn(), 9.0), THREAD
    )

    first = [c for c in _chunks(client)[0] if c["type"] == "blocks"]
    assert [chunk["blocks"][0]["title"] for chunk in first] == [
        "Working… 1s · Last: Tool 48"
    ]
    later = [c for c in _chunks(client)[1] if c["type"] == "blocks"]
    assert [chunk["blocks"][0]["title"] for chunk in later] == [
        "Activity 1–49",
        "Working… 9s · Last: Tool 49",
    ]


async def test_a_step_title_is_not_escaped_because_nothing_in_it_is_parsed() -> None:
    """Measured, not read: a card's title parses no mrkdwn, so a title sent
    escaped is stored and shown escaped. Escaping it put `&amp;&amp;` in front
    of a reader wherever a tool call held a shell `&&`."""
    client = FakeWebClient()
    adapter = _adapter(client)
    shell = 'Bash echo "x" && ls 2>/dev/null'

    await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([_tool("t1", shell)], _turn(), 1.0), THREAD
    )

    assert _steps(client)[0]["title"] == shell
    assert _pages(client)[0]["title"] == f"Working… 1s · Running: {shell}"


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
    assert (
        _chunks(client)[-1][0]["blocks"][0]["title"] == "Worked for 30s. 1 tool call."
    )


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


# ── When the stop is refused ─────────────────────────────────────────────────
#
# The publisher records a turn as ended on a draw that reported success and
# drops its anchor with it. So a stop that quietly failed leaves a message in
# its streaming state that nothing is coming back for — a spinner over a turn
# that finished, for good. Every refusal has to reach the caller instead.


async def test_a_turn_whose_stream_will_not_close_is_still_owed() -> None:
    """A refused stop fails the publication rather than being logged past.

    The stream is kept rather than forgotten, which is the safer half: one this
    process has forgotten is one the next publication tries to *edit*, and
    there is no edit that can hold a turn drawn in two sections. Holding the
    record means the retry appends, finds nothing moved, and asks again.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )

    client.stop_error = "internal_error"
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert client.stopped == []
    assert ref in adapter._streams
    assert ref not in adapter._unredrawable


async def test_a_close_slack_is_too_busy_for_holds_the_rest_of_the_batch_back() -> None:
    """The likely refusal, and the reason the close is careful at all.

    A restart ends every stream it stranded at roughly the same moment, through
    a budget belonging to the workspace rather than to any one message. So the
    cooldown is recorded as well as reported, and the turns queued behind this
    one wait it out instead of walking into the refusal it was just given.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )

    client.stop_error = FakeResponse(
        {"error": "ratelimited"}, headers={"Retry-After": "13"}
    )
    with pytest.raises(RichContentThrottled) as waiting:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert waiting.value.retry_after == 13
    assert ref in adapter._streams
    assert len(client.stop_attempts) == 1


async def test_a_close_that_was_refused_is_simply_asked_again() -> None:
    """What the retry costs, which is the point of keeping the stream.

    Everything the turn drew is already recorded as sent, so the second attempt
    appends nothing at all and spends one call: the stop that was refused.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    ended = TurnActivity([tool], _turn("completed"), 9.0)

    client.stop_error = "internal_error"
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(CHANNEL, "Agent", ref, ended, THREAD)
    drawn = len(client.appended)

    client.stop_error = None
    await adapter.update_rich(CHANNEL, "Agent", ref, ended, THREAD)

    assert client.stopped == [{"channel": CHANNEL, "ts": "1.0"}]
    assert len(client.appended) == drawn
    assert adapter._streams == {}


async def test_a_stream_slack_says_is_already_closed_is_treated_as_closed() -> None:
    """Closed is closed, whoever closed it — a reader pressing stop, or a run
    of this that got as far as the stop last time. Nothing is owed and there is
    nothing to report, so it settles exactly as a clean close does."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )

    client.stop_error = "message_not_in_streaming_state"
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
    )

    assert adapter._streams == {}


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


async def test_a_turn_that_has_already_ended_is_posted_rather_than_streamed() -> None:
    """Nothing is ever appended to a turn that is over, so it is not streamed.

    A stream would have to be opened and closed inside the one post, and the
    whole turn drawn in between.
    """
    client = FakeWebClient()
    adapter = _adapter(client)

    ref = await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool("t1", "Read")], _turn("completed"), 9.0),
        THREAD,
    )

    assert client.started == []
    assert len(client.posted) == 1
    assert client.posted[0]["blocks"][0]["type"] == "plan"
    assert ref == f"{CHANNEL}:1.0"


async def test_a_finished_turn_is_not_reported_unposted_over_a_refused_stop() -> None:
    """The reason the check above is about opening rather than about failing.

    A post that raises is a post the caller treats as definitely refused: it
    drops the delivery reservation and a retry draws the turn again. So a stop
    Slack would not take must not be able to fail a *post*, or Slack ends up
    holding the message and the turn is published twice.

    There is no stream to close here, so the refusal is never reached.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    client.stop_error = "internal_error"

    ref = await adapter.post_rich(
        CHANNEL,
        "Agent",
        TurnActivity([_tool("t1", "Read")], _turn("completed"), 9.0),
        THREAD,
    )

    assert ref == f"{CHANNEL}:1.0"
    assert client.started == []
    assert client.stop_attempts == []
    assert adapter._streams == {}


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


async def test_a_turn_of_two_sections_is_left_as_the_stream_drew_it(
    caplog: Any,
) -> None:
    """The one thing an edit cannot take back.

    Measured, not read: `chat.update` refuses a message carrying two plan
    blocks exactly as `chat.postMessage` does, and refuses it on a message a
    stream itself built. So a turn long enough to have overflowed its first
    section can only be redrawn as the single section the fallback draws — the
    whole turn replaced by its last forty-nine lines, under a reader who
    watched it run. Once the stream has closed, the message stands.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
    )
    with caplog.at_level(logging.WARNING):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
        )

    assert client.updated == []
    assert "holds two sections" in caplog.text
    assert [page["title"] for page in _pages(client)] == [
        "Activity 1–49",
        "Worked for 9s. 60 tool calls.",
    ]


async def test_a_turn_whose_last_append_was_refused_is_still_drawn_by_an_edit() -> None:
    """The guard preserves a finished turn, not an interrupted one.

    If the append carrying the end of the turn is refused, the message is still
    showing the turn mid-flight. Declining to edit it would leave it that way
    for good and report success for a completion nobody ever saw. A collapsed
    message that says the turn ended beats a whole one that says it is running.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    client.append_error = "stopped_by_user"
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
        )
    client.append_error = None
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
    )

    assert adapter._unredrawable == {}
    assert [call["ts"] for call in client.updated] == ["1.0"]


async def test_a_stream_dropped_to_make_room_leaves_its_message_editable() -> None:
    """Same eligibility: its turn never ended, so it never drew the end."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]

    first = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    for index in range(_MAX_OPEN_STREAMS):
        await adapter.post_rich(
            CHANNEL,
            "Agent",
            TurnActivity([_tool(f"x{index}", "Read")], _turn()),
            THREAD,
        )

    assert first not in adapter._streams
    assert adapter._unredrawable == {}


async def test_a_message_that_says_it_cannot_be_redrawn_says_it_once(
    caplog: Any,
) -> None:
    """A turn that has ended is still published for as long as anything about
    it moves, and a line of log on each of those would bury the one that
    matters."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    with caplog.at_level(logging.WARNING):
        for elapsed in (9.0, 10.0, 11.0, 12.0):
            await adapter.update_rich(
                CHANNEL,
                "Agent",
                ref,
                TurnActivity(many, _turn("completed"), elapsed),
                THREAD,
            )

    said = [
        record for record in caplog.records if "holds two sections" in record.message
    ]
    assert len(said) == 1


async def test_a_turn_that_never_left_one_section_is_still_redrawn() -> None:
    """The guard is about what an edit cannot carry, not about having streamed.

    A turn that fits one section draws the same single block either way, so the
    message is still the whole turn after an edit and a revision that lands
    late is still worth showing.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read", status="completed")
    url = "https://switch.example/session"

    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity([tool], _turn("completed"), 9.0, session_url=url),
        THREAD,
    )

    assert [call["ts"] for call in client.updated] == ["1.0"]
    assert adapter._unredrawable == {}


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
    assert [block["title"] for block in adapter._streams[ref].blocks.values()] == [
        "Working… 1s · Running: Read"
    ]


# ── When a restart strands a stream ──────────────────────────────
#
# The open-stream registry is held on the adapter and written nowhere else, so
# a restart loses it while Slack keeps its side. The message is then in a state
# no code here knows about: Slack refuses every edit to it as a
# `streaming_state_conflict`, and if the turn it belonged to has ended, no
# append is coming that would notice. Observed in a live workspace, where a
# rebuild left twenty-two turns showing a spinner days after they finished,
# each one re-attempted every thirty seconds and refused every time.
#
# Slack refusing the edit is itself the proof the message is still streaming and
# still ours, so the answer is to take the stream back and append to it. That
# repairs what an edit cannot: a message drawn in two sections is one
# `chat.update` refuses outright, and a turn still running when the process died
# carries on streaming rather than finishing as a series of edits.
#
# Closing the stream and editing the message is the fallback underneath, for
# when Slack will not take the append after all. Either way the retry
# terminates, because a message can only be stranded once.


def _strand(adapter: SlackAdapter, ref: str) -> None:
    """Lose the record of an open stream, as a restart does."""
    adapter._streams.pop(ref)


def _appended_ids(client: FakeWebClient) -> list[list[str]]:
    """The block ids each append carried, oldest append first."""
    return [
        [chunk["blocks"][0]["block_id"] for chunk in call["chunks"]]
        for call in client.appended
    ]


# ── Taking the stream back ──────────────────────────────────────


async def test_an_edit_refused_by_a_stranded_stream_takes_the_stream_back(
    caplog: Any,
) -> None:
    """The message is drawn on its own stream again, not edited into."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    with caplog.at_level(logging.WARNING):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    # One refused edit, then everything else over the stream.
    assert len(client.update_attempts) == 1
    assert client.updated == []
    assert len(client.appended) == 2
    assert "Took back the activity stream" in caplog.text
    # The turn had ended, so taking it back also ends it properly.
    assert [(call["channel"], call["ts"]) for call in client.stopped] == [
        (CHANNEL, "1.0")
    ]


async def test_a_stranded_stream_resends_every_section_it_cannot_account_for() -> None:
    """The adopted record is empty of the turn, so the whole turn goes again.

    This is the repair. Nothing here knows what of the message Slack is still
    holding — the record that would have said was lost with the restart — so
    assuming any block is current would leave it stale for good.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
    )

    assert _appended_ids(client)[-1] == [
        "switch-steps-top",
        "switch-interrupt",
        "switch-steps-middle",
    ]


@pytest.mark.parametrize("status", ["running", "completed"])
@pytest.mark.parametrize(
    ("steps", "held"),
    [
        (1, ["switch-steps-top", "switch-interrupt"]),
        (50, ["switch-steps-top", "switch-interrupt", "switch-steps-middle"]),
        (
            99,
            [
                "switch-steps-top",
                "switch-interrupt",
                "switch-steps-middle",
                "switch-steps-bottom",
            ],
        ),
    ],
)
async def test_a_stream_opened_before_the_handoff_is_repaired_and_not_doubled(
    steps: int, held: list[str], status: str
) -> None:
    """The upgrade case: a stream still open across the deploy that changed this.

    `held` is what the release before the hand-down had physically created on
    the message by the time it had that many section blocks — the sections and
    the control, in the order it made them. The redraw writes to exactly those
    ids and no others, so every block it sends replaces one Slack is already
    holding, in the position it already occupies.

    That is the whole of the compatibility argument. Slack addresses blocks by
    id and removes none, so an id this draw invented would leave the old
    sections on screen and add a second copy of the turn underneath them, with
    the old stop button live between the two. Instead the old control's slot is
    taken by a section and the control moves to the end, which is the same
    hand-down an unbroken stream does — the restart makes no difference to it.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(steps)]
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity(many, _turn(status), 9.0, interrupt_turn_id=TURN),
        THREAD,
    )

    assert _appended_ids(client)[-1] == held
    live = [
        chunk["blocks"][0]
        for chunk in client.appended[-1]["chunks"]
        if chunk["blocks"][0]["type"] == "actions"
    ]
    assert bool(live) is (status == "running")


async def test_a_stranded_two_section_turn_is_repaired_rather_than_left_alone() -> None:
    """The case an edit can never fix, which is why reattaching is worth it.

    `chat.update` refuses a message holding two plan blocks, so the older
    recovery could only close the stream and leave the turn on whatever the
    stream last wrote. An append replaces a block Slack already has, two
    sections or not, so the heading is brought up to date instead.

    The message is still recorded as unredrawable once the stream closes behind
    it, and that is right: from then on it really is beyond an edit. The
    difference the repair makes is what it is left showing.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
    )

    sections = [
        chunk["blocks"][0]
        for chunk in client.appended[-1]["chunks"]
        if chunk["blocks"][0]["type"] == "plan"
    ]
    assert len(sections) == 2
    # The heading a finished turn gets, on the message an edit could not reach.
    assert sections[-1]["title"].startswith("Worked for 9s")
    assert client.updated == []
    assert adapter._unredrawable[ref] is False


async def test_a_stranded_stream_whose_turn_has_ended_loses_its_stop_control() -> None:
    """The one thing the adopted record has to remember.

    A stream keeps a block it is no longer sent, and a turn that ended while
    this process was away renders no stop control at all — so a record that
    knew nothing of the message would never write over the button on screen,
    and the reader would keep a live-looking control over a finished turn for
    good. `_STRANDED_BLOCKS` is what stops that.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
    )

    # One section, so the control was in the slot below it.
    spent = [
        chunk["blocks"][0]
        for chunk in client.appended[-1]["chunks"]
        if chunk["blocks"][0]["type"] == "divider"
    ]
    assert spent == [{"type": "divider", "block_id": "switch-interrupt"}]


async def test_a_stranded_turn_still_running_keeps_its_stop_control() -> None:
    """The mirror of the above: the control is resent, not written over.

    The record claims the control is there so that a finished turn can take it
    away, and the value it claims is one no renderer produces — so a turn that
    is in fact still going has its button drawn again rather than mistaken for
    one already on screen.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL,
        "Agent",
        ref,
        TurnActivity([tool], _turn(), 9.0, interrupt_turn_id=TURN),
        THREAD,
    )

    control = [
        chunk["blocks"][0]
        for chunk in client.appended[-1]["chunks"]
        if chunk["blocks"][0]["block_id"] == "switch-interrupt"
    ]
    assert control and control[0]["type"] == "actions"


async def test_a_stranded_turn_still_running_carries_on_streaming() -> None:
    """What Simon asked for: reattach, then continue, without stopping.

    The stream is not closed while the turn is live, the adopted record is
    kept, and the publication after it appends directly — no second refused
    edit, so the conflict is paid for once and not on every tick.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 9.0), THREAD
    )
    assert client.stopped == []
    assert ref in adapter._streams

    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 14.0), THREAD
    )
    assert len(client.update_attempts) == 1
    assert len(client.appended) == 3


async def test_a_stranded_stream_is_taken_back_once_and_then_simply_appended_to() -> (
    None
):
    """Termination, which is the point. The conflict is not met twice."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 9.0), THREAD
    )
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 14.0), THREAD
    )

    assert len(client.update_attempts) == 1
    assert len(client.stopped) == 1


async def test_a_stranded_stream_slack_is_too_busy_to_append_to_is_waited_out() -> None:
    """A rate limit is not a refusal, and must not be answered as one.

    A restart strands every stream that was open — twenty-two of them, the time
    this was found — recovered one after another through a budget belonging to
    the workspace. Taking the throttle as "Slack will not have the append" would
    close every one of those streams and give up the repair over a queue that
    was only busy.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.append_error = FakeResponse(
        {"error": "ratelimited"}, headers={"Retry-After": "17"}
    )
    with pytest.raises(RichContentThrottled) as waiting:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert waiting.value.retry_after == 17
    assert client.stopped == []
    assert client.updated == []
    # The record is kept, so the retry appends rather than meeting the conflict
    # again — and the cooldown holds the rest of the batch back meanwhile.
    assert ref in adapter._streams
    with pytest.raises(RichContentThrottled):
        await adapter.update_rich(
            CHANNEL, "Agent", "C1:2.0", TurnActivity([tool], _turn(), 9.0), THREAD
        )


async def test_a_reattached_turn_whose_close_is_throttled_stays_owed() -> None:
    """The burst this whole recovery exists for, at its last step.

    Twenty-two stranded streams take their repair appends and then reach the
    stop one after another through the workspace's budget. A refusal there has
    to be waited out and still owed — otherwise the message is repaired,
    reported as ended, and left streaming with nothing coming back for it.

    The fallback is deliberately not run. The append landed and the message is
    already right; closing and editing has nothing to offer but the same
    refusal a second time, on the budget that just gave it.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.stop_error = FakeResponse(
        {"error": "ratelimited"}, headers={"Retry-After": "11"}
    )
    with pytest.raises(RichContentThrottled) as waiting:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert waiting.value.retry_after == 11
    assert len(client.stop_attempts) == 1
    assert client.updated == []
    assert len(client.update_attempts) == 1
    # Adopted and kept, so the retry appends straight to it rather than going
    # back through a conflict to find its way here again.
    assert ref in adapter._streams


async def test_a_reattached_turn_whose_close_is_refused_does_not_run_the_fallback() -> (
    None
):
    """A definite refusal, same reasoning: the repair is done and the fallback
    would only ask a second time. It reaches the caller as a failure so the
    turn stays owed, and the adopted stream is kept for the retry."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.stop_error = "internal_error"
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert len(client.stop_attempts) == 1
    assert client.updated == []
    assert ref in adapter._streams


async def test_a_reattached_turn_slack_had_already_closed_needs_nothing_further() -> (
    None
):
    """Adopting a stream someone else already stopped still finishes the turn.

    The repair append lands, so the message is right; the stop then says the
    stream was never open. Nothing is owed and nothing is edited — the same
    settle an ordinary already-closed stream gets, reached the long way round.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.stop_error = "message_not_in_streaming_state"
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
    )

    assert adapter._streams == {}
    assert client.updated == []


async def test_a_reattached_close_that_was_refused_is_asked_again_and_no_more() -> None:
    """The retry after a refused close, on a stream that was adopted.

    The record was kept, so the second attempt goes straight to the stream
    rather than meeting the conflict again: no further `chat.update`, no repeat
    of the repair append, and one more stop — which closes it.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)
    ended = TurnActivity([tool], _turn("completed"), 9.0)

    client.update_errors = ["streaming_state_conflict"]
    client.stop_error = "internal_error"
    with pytest.raises(RichContentFailed):
        await adapter.update_rich(CHANNEL, "Agent", ref, ended, THREAD)
    repaired = len(client.appended)
    attempted = len(client.update_attempts)

    client.stop_error = None
    await adapter.update_rich(CHANNEL, "Agent", ref, ended, THREAD)

    assert client.stopped == [{"channel": CHANNEL, "ts": "1.0"}]
    assert len(client.appended) == repaired
    assert len(client.update_attempts) == attempted
    assert adapter._streams == {}


# ── Closing it instead, when the append is refused ───────────────────────


async def test_a_stranded_stream_that_will_not_take_an_append_is_closed_and_edited(
    caplog: Any,
) -> None:
    """The fallback, which is the whole of the older fix.

    Worth keeping rather than replacing: it ends the retry loop on its own, so
    an append Slack declines costs the two-section repair and nothing else.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict", None]
    client.append_error = "message_not_owned_by_app"
    with caplog.at_level(logging.WARNING):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert [(call["channel"], call["ts"]) for call in client.stopped] == [
        (CHANNEL, "1.0")
    ]
    assert [call["ts"] for call in client.updated] == ["1.0"]
    assert "would not take an append" in caplog.text
    assert "still held open" in caplog.text
    assert ref not in adapter._streams


async def test_a_stranded_two_section_turn_is_kept_rather_than_blanked(
    caplog: Any,
) -> None:
    """The trap in the obvious version of the fallback.

    `update_blocks` answers a refusal of the blocks with an empty `blocks`
    array, which clears stale controls off a card Slack judged malformed. A
    message a stream drew in two sections is refused for its own shape rather
    than the edit's, and it is already showing the whole finished turn — so
    reaching that fallback here would take the turn off the screen to fix a
    spinner. It is recorded as unredrawable and left alone instead.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict", "invalid_blocks"]
    client.append_error = "message_not_owned_by_app"
    with caplog.at_level(logging.WARNING):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
        )

    assert client.stopped != []
    assert client.updated == []
    assert [call["blocks"] for call in client.update_attempts].count([]) == 0
    assert adapter._unredrawable[ref] is True
    assert "keeps the status its stream last wrote" in caplog.text


async def test_a_stranded_message_left_unredrawable_is_not_edited_again() -> None:
    """Having said so once, later publications are declined without a call."""
    client = FakeWebClient()
    adapter = _adapter(client)
    many = [_tool(f"t{n}", f"Tool {n}", status="completed") for n in range(60)]
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity(many, _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict", "invalid_blocks"]
    client.append_error = "message_not_owned_by_app"
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 9.0), THREAD
    )
    attempts = len(client.update_attempts)
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity(many, _turn("completed"), 14.0), THREAD
    )

    assert len(client.update_attempts) == attempts


async def test_a_stream_slack_will_neither_extend_nor_close_is_reported() -> None:
    """Both ways out refused, so the caller is told which call failed."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.append_error = "message_not_owned_by_app"
    client.stop_error = "internal_error"
    with pytest.raises(RichContentFailed) as refused:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert "would not close the stream" in str(refused.value)
    assert "internal_error" in str(refused.value)


async def test_a_stream_slack_has_already_dropped_is_redrawn_rather_than_reported() -> (
    None
):
    """The state Slack actually leaves a wedged card in, measured in the wild.

    Slack refuses the edit as a message that is streaming and answers both
    stream calls with `message_not_found`: the message is still flagged, and
    the stream that flag refers to is gone. Every other caller reads that as
    the stream being over, so the fallback does too and spends its one
    remaining move on the message instead of reporting a failure nothing can
    act on.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.append_error = "message_not_found"
    client.stop_error = "message_not_found"
    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
    )

    assert client.updated, "the turn should have been redrawn into the message"


async def test_a_wedged_message_is_given_up_on_rather_than_asked_about_forever() -> (
    None
):
    """The whole of the deadlock, and the thing that has to stop asking.

    Slack keeps the streaming flag and has dropped the stream, so the edit is
    refused as streaming and both stream calls are refused as gone. Nothing
    sendable changes the message, and the cost of not noticing is two calls
    against the workspace's rate budget every few seconds, for the life of the
    process, per wedged card.

    The discovery raises, so the caller can say beside the message what the
    message can no longer say for itself. Every attempt after it returns
    quietly: the point of raising was to stop being asked, and raising again
    would report the same permanent condition on every cycle.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_error = "streaming_state_conflict"
    client.append_error = "message_not_found"
    client.stop_error = "message_not_found"
    with pytest.raises(RichContentWedged):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )
    spent = len(client.update_attempts) + len(client.stop_attempts)

    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 14.0), THREAD
    )

    assert len(client.update_attempts) + len(client.stop_attempts) == spent, (
        "a message nothing can change should not be asked about again"
    )


async def test_a_wedge_is_remembered_past_the_number_of_streams_that_may_be_open() -> (
    None
):
    """The two bounds count different things and must not share a number.

    Open streams are capped because a stream is a live thing worth abandoning
    when there are too many. A wedge is the opposite: the entry is the only
    reason a message nothing can change is left alone, so dropping one resumes
    the asking it was recorded to stop, with no restart and nothing to show a
    reader why that card started burning calls again.

    Pinned at the open-stream bound specifically, because that is the number
    this shared until it was given its own, and the fault it caused would be
    invisible — a card quietly re-probed every few seconds.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)
    client.update_error = "streaming_state_conflict"
    client.append_error = "message_not_found"
    client.stop_error = "message_not_found"
    with pytest.raises(RichContentWedged):
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )
    spent = len(client.update_attempts) + len(client.stop_attempts)

    for index in range(_MAX_OPEN_STREAMS + 50):
        adapter._remember_unredrawable(f"{CHANNEL}:wedged-{index}", warned=True)

    await adapter.update_rich(
        CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 14.0), THREAD
    )

    assert len(client.update_attempts) + len(client.stop_attempts) == spent, (
        "the first wedge is still remembered after more than _MAX_OPEN_STREAMS "
        "others, so it is not asked about again"
    )

    for index in range(_MAX_WEDGED_MESSAGES):
        adapter._remember_unredrawable(f"{CHANNEL}:overflow-{index}", warned=True)

    assert len(adapter._unredrawable) == _MAX_WEDGED_MESSAGES, (
        "still bounded, so a long-lived process cannot grow this without limit"
    )


async def test_a_rate_limit_that_freezes_every_card_says_so(caplog: Any) -> None:
    """The cooldown is adapter-wide and was silent, which is the hard part.

    One refused call holds back every message the bridge draws, for as long as
    Slack asked. Without a line saying so, a reader sees every card in the
    workspace stop moving at once and nothing anywhere explaining why.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_error = "ratelimited"
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RichContentThrottled):
            await adapter.update_rich(
                CHANNEL, "Agent", ref, TurnActivity([tool], _turn(), 9.0), THREAD
            )

    assert "rate limiting message updates for the whole workspace" in caplog.text
    assert "Every card the bridge draws is frozen" in caplog.text, (
        "the consequence has to be this limit's own: a reaction limit stops "
        "marks changing and leaves the cards redrawing"
    )


async def test_a_stranded_stream_slack_is_too_busy_to_close_is_waited_out() -> None:
    """The throttle again, on the fallback's own first call."""
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = ["streaming_state_conflict"]
    client.append_error = "message_not_owned_by_app"
    # Refused by the HTTP layer, which names no error this recognises — Slack
    # has spelled that one two ways over the years and the status is what holds
    # across both.
    client.stop_error = FakeResponse(
        {"error": "rate_limited"}, headers={"Retry-After": "17"}, status_code=429
    )
    with pytest.raises(RichContentThrottled) as waiting:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert waiting.value.retry_after == 17
    assert client.stopped == []
    assert len(client.update_attempts) == 1

    # The cooldown is the workspace's, so the twenty-one behind this one wait
    # it out too rather than walking into the refusal it was just given.
    with pytest.raises(RichContentThrottled):
        await adapter.update_rich(
            CHANNEL,
            "Agent",
            "C1:2.0",
            TurnActivity([tool], _turn("completed"), 9.0),
            THREAD,
        )
    assert len(client.update_attempts) == 1


async def test_a_stranded_stream_closed_but_not_redrawn_in_time_is_waited_out() -> None:
    """Closed, which is the half that ends the loop; only the redraw was late.

    The message is an ordinary one from here, so the retry is an ordinary edit
    — but it waits out Slack's window rather than taking the publisher's next
    tick. And a refusal to wait is not a refusal of the blocks: recording it as
    unredrawable would leave the turn showing a spinner for good over a message
    Slack has no objection to editing.
    """
    client = FakeWebClient()
    adapter = _adapter(client)
    tool = _tool("t1", "Read")
    ref = await adapter.post_rich(
        CHANNEL, "Agent", TurnActivity([tool], _turn(), 1.0), THREAD
    )
    _strand(adapter, ref)

    client.update_errors = [
        "streaming_state_conflict",
        FakeResponse({"error": "ratelimited"}, headers={"Retry-After": "8"}),
    ]
    client.append_error = "message_not_owned_by_app"
    with pytest.raises(RichContentThrottled) as waiting:
        await adapter.update_rich(
            CHANNEL, "Agent", ref, TurnActivity([tool], _turn("completed"), 9.0), THREAD
        )

    assert waiting.value.retry_after == 8
    assert len(client.stopped) == 1
    assert ref not in adapter._unredrawable
