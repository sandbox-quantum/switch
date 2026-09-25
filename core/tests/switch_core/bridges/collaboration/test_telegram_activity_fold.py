"""A Telegram turn's tool calls, collapsed into the status that summarises them.

Telegram has no message a bot can post to one reader. The only private surface
a press can reach is the reply to a callback query, which is capped at a couple
of sentences, so Discord's answer — a private copy fetched on demand — has
nowhere to land. `<blockquote expandable>` is drawn by the reader's own client
instead: the log travels in the status message, collapsed, and opening it
reaches Switch in no way at all.

The two things that fall out of drawing it that way, and are tested here:

- the fold is offered on an *ended* turn only. Editing a message closes a block
  a reader had opened — observed on a real chat, not reasoned from the docs —
  and a running turn's status is edited on every tool call.
- the log is charged to the same message as the status. Telegram rejects an
  over-long message outright and an edit cannot be split, so what a turn's
  calls may spend is whatever the status left.
"""

from __future__ import annotations

import re
from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.telegram.chunking import MAX_MESSAGE

from .session_fixtures import _item, _turn
from .test_telegram_adapter import _adapter, _bot
from .test_telegram_sdk_only import CHANNEL, SESSION_URL, _card, _running

_FOLD_RE = re.compile(r"<blockquote expandable>(.*)</blockquote>", re.DOTALL)


def _ended(*titles: str, **kwargs: Any) -> TurnActivity:
    """A finished turn that made the named calls, in the order named."""
    items = [
        _item(itemId=f"item-{position}", title=title)
        for position, title in enumerate(titles, start=1)
    ]
    return TurnActivity(items, _turn("completed"), **kwargs)


def _fold(text: str) -> list[str]:
    """The lines inside the collapsed block, or nothing where there is no block."""
    found = _FOLD_RE.search(text)
    return found.group(1).split("\n") if found else []


def _sent(adapter: Any) -> str:
    return str(_bot(adapter).messages[0]["text"])


def _last_edit(adapter: Any) -> str:
    return str(_bot(adapter).edits[-1]["text"])


# ── When the fold is offered ─────────────────────────────────────────────────


async def test_a_finished_turn_carries_its_tool_calls_folded_under_the_status() -> None:
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended("Read a file", "Ran a test"), None
    )

    assert _fold(_sent(adapter)) == ["⌗ ✓ Read a file", "⌗ ✓ Ran a test"]


async def test_a_running_turn_is_offered_no_fold_because_the_next_edit_shuts_it() -> (
    None
):
    """Telegram closes an expanded block when the message it is in is edited,
    and a running turn is edited on every tool call. A log that shut in the
    reader's face mid-read would be worse than the status line they had."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", _running(), None)

    assert _fold(_sent(adapter)) == []


async def test_the_fold_arrives_on_the_edit_that_ends_the_turn() -> None:
    """The status is posted while the turn runs and rewritten when it stops, so
    the edit is the only place the log can appear — nothing posts it again."""
    adapter = _adapter()
    ref = await adapter.post_rich(CHANNEL, "my-agent", _running(), None)

    await adapter.update_rich(CHANNEL, "my-agent", ref, _ended("Ran a test"), None)

    assert _fold(_last_edit(adapter)) == ["⌗ ✓ Ran a test"]


async def test_a_turn_with_nothing_behind_it_is_offered_nothing_to_open() -> None:
    """The block promises something is behind it. "No activity." under a status
    line already saying so is not what anybody went looking for.

    An item a host has opened and not yet filled is nothing behind it: the
    agent has not said anything yet, it has been given somewhere to say it.
    """
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        TurnActivity([_item(kind="assistant-message")], _turn("completed")),
        None,
    )

    assert _fold(_sent(adapter)) == []


async def test_the_message_a_failure_gets_of_its_own_does_not_repeat_the_log() -> None:
    """A problem somebody has to act on is published here as a second message,
    because an edit does not notify. It is drawn from no items at all, so the
    same check that spares an empty turn keeps one log out of the chat twice."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        TurnActivity(
            [], _turn("error"), status_only=True, error_summary="The turn failed."
        ),
        None,
    )

    assert _fold(_sent(adapter)) == []


async def test_a_request_card_is_offered_its_options_rather_than_a_fold() -> None:
    """One message asks one thing. Only a turn has a log to fold, and only a
    card has options to press."""
    adapter = _adapter()

    await adapter.post_rich(CHANNEL, "my-agent", await _card(), None)

    assert _fold(_sent(adapter)) == []


# ── What is inside it ────────────────────────────────────────────────────────


async def test_the_log_does_not_repeat_the_status_it_is_folded_under() -> None:
    """The status sits immediately above and carries the turn's state and its
    Console link. Printing both again as the log's first line is the message
    saying the same sentence twice, a centimetre apart."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended("Ran a test", session_url=SESSION_URL), None
    )

    text = _sent(adapter)
    assert SESSION_URL in text
    assert _fold(text) == ["⌗ ✓ Ran a test"]


async def test_the_calls_read_oldest_first_so_the_newest_is_where_it_ended() -> None:
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended("First", "Second", "Third"), None
    )

    assert _fold(_sent(adapter)) == ["⌗ ✓ First", "⌗ ✓ Second", "⌗ ✓ Third"]


async def test_host_text_in_the_log_cannot_close_the_block_it_is_inside() -> None:
    """Every title in there came from a host. Telegram parses the whole message
    as HTML and rejects all of it over one stray tag, so a title carrying one
    would cost the turn its status as well as its log."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended("Read </blockquote><b>everything"), None
    )

    text = _sent(adapter)
    assert text.count("</blockquote>") == 1
    assert "&lt;/blockquote&gt;" in text


async def test_a_log_too_long_for_the_message_is_cut_and_says_how_much() -> None:
    """A turn with hundreds of calls must not push the message past what
    Telegram accepts, and a log that quietly showed its tail reads as a turn
    that made only those calls."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended(*[f"Call {n}" for n in range(400)]), None
    )

    lines = _fold(_sent(adapter))
    assert lines[0].startswith("…")
    assert "not shown" in lines[0]
    assert lines[-1] == "⌗ ✓ Call 399"


async def test_the_notice_that_nobody_was_reached_stays_out_of_the_fold() -> None:
    """It is about the message rather than about the turn, and a reader who has
    not opened the block is exactly the reader it is for."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended("Ran a test", notify_unreachable=True), None
    )

    text = _sent(adapter)
    assert adapter.unnotified_notice() in text
    assert _fold(text) == ["⌗ ✓ Ran a test"]


async def test_what_the_agent_said_is_in_the_fold_and_not_in_the_chat() -> None:
    """The prose an agent produces beside its work never reached this chat at
    all. It arrives folded rather than in the status line, because the reply is
    what the chat gets unprompted and much of the rest is the agent narrating
    itself."""
    adapter = _adapter()
    said = _item(itemId="item-2", kind="assistant-message", title="", text="All green.")

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        TurnActivity(
            [_item(itemId="item-1", title="Ran the tests"), said], _turn("completed")
        ),
        None,
    )

    text = _sent(adapter)
    assert _fold(text) == ["⌗ ✓ Ran the tests", "❝ All green."]
    assert "All green." not in text.split("\n<blockquote")[0]


async def test_a_turn_that_only_talked_is_still_worth_a_fold() -> None:
    """It used to be offered nothing, because it called nothing. Now the thing
    it produced is the thing behind the block."""
    adapter = _adapter()

    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        TurnActivity(
            [_item(kind="assistant-message", title="", text="Fixed yesterday.")],
            _turn("completed"),
        ),
        None,
    )

    assert _fold(_sent(adapter)) == ["❝ Fixed yesterday."]


# ── What it costs the message ────────────────────────────────────────────────


async def test_a_folded_turn_still_fits_in_one_telegram_message() -> None:
    """An edit cannot be split, and `_clamp` cutting this one would take the
    closing tag with it and have Telegram reject the whole redraw."""
    adapter = _adapter()
    long_call = "Read " + "a very long path " * 20

    await adapter.post_rich(
        CHANNEL, "my-agent", _ended(*[f"{long_call} {n}" for n in range(400)]), None
    )

    assert len(_sent(adapter)) <= MAX_MESSAGE


async def test_the_status_is_not_made_smaller_to_make_room_for_the_log() -> None:
    """The fold spends what the status left, not the other way round. A turn's
    state and its Console link are what a reader gets either way."""
    adapter = _adapter()
    await adapter.post_rich(
        CHANNEL, "my-agent", _ended("Ran a test", session_url=SESSION_URL), None
    )
    short = _sent(adapter).split("\n<blockquote")[0]

    adapter = _adapter()
    await adapter.post_rich(
        CHANNEL,
        "my-agent",
        _ended(*[f"Call {n}" for n in range(400)], session_url=SESSION_URL),
        None,
    )

    assert SESSION_URL in short
    assert _sent(adapter).split("\n<blockquote")[0] == short


async def test_a_budget_too_small_for_one_call_is_no_block_rather_than_an_empty_one() -> (
    None
):
    """The floor of the arithmetic above, reached only where the status has
    taken the whole message. A block a reader opens onto nothing is worse than
    the status on its own, which still says how the turn went and links the
    Console."""
    adapter = _adapter()

    assert adapter._activity_fold(_ended("Ran a test"), 10) == ""


async def test_a_turn_republished_after_a_refusal_still_carries_its_calls() -> None:
    """`rich_fallback_text` is what the publisher posts when the drawing itself
    was refused. It is the same drawing without the name and the buttons, and a
    turn that arrives there having apparently called nothing is a worse record
    than no record."""
    adapter = _adapter()

    fallback = adapter.rich_fallback_text(_ended("Ran a test"))

    assert _fold(fallback) == ["⌗ ✓ Ran a test"]
