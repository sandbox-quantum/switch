"""Where a tool call's detail is drawn, for a room that has it switched on.

Slack puts it in the call's collapsed card, and Mattermost and Discord in the
activity view a reader asks for. Teams and Telegram draw none of it, whatever
the room says: their log travels inside the turn's own message.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    NO_TOOL_DETAILS,
)
from switch_core.bridges.collaboration.session.renderers.neutral import activity_log
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
    render_activity_stream,
)
from switch_core.sessions.contract import Item

from .session_fixtures import _item, _turn
from .test_mattermost_activity_view import _snapshot, _viewer
from .test_teams_activity_fold import _log_lines, _posted
from .test_teams_adapter import _run
from .test_teams_sdk_only import AGENT, CHANNEL, ROOT, _teams
from .test_telegram_activity_fold import _fold, _sent
from .test_telegram_adapter import _adapter as _telegram
from .test_telegram_sdk_only import CHANNEL as TELEGRAM_CHANNEL

DETAIL = "$ grep -n TODO src/*.py && echo <done>\nsrc/app.py:12: TODO"


def _call(item_id: str = "call-1", title: str = "Searched for TODO") -> Item:
    return _item(itemId=item_id, kind="tool-activity", title=title, text="")


def _card_details(blocks: list[dict[str, Any]]) -> dict[str, str]:
    """Each call card's detail text, by its title."""
    return {
        str(task["title"]): task["details"]["elements"][0]["elements"][0]["text"]
        for block in blocks
        if block.get("type") == "plan"
        for task in block["tasks"]
        if task.get("task_id") != "switch-session" and "details" in task
    }


# ── Slack: the collapsed card ────────────────────────────────────────────────


def test_slack_puts_a_calls_detail_in_its_card_as_written() -> None:
    """Literal: the `&&`, `*` and `<done>` are what ran, and the card renders
    no markup that would need them taken out."""
    drawn = render_activity_plan(
        [_call()], _turn("completed"), tool_details={"call-1": DETAIL}
    )

    assert _card_details(drawn.blocks) == {"Searched for TODO": DETAIL}


def test_a_streamed_slack_turn_carries_the_same_detail() -> None:
    drawn = render_activity_stream(
        [_call()], _turn("running"), tool_details={"call-1": DETAIL}
    )

    assert _card_details(drawn.blocks) == {"Searched for TODO": DETAIL}


def test_slack_draws_no_detail_for_a_room_that_shows_none() -> None:
    drawn = render_activity_plan(
        [_call()], _turn("completed"), tool_details=NO_TOOL_DETAILS
    )

    assert _card_details(drawn.blocks) == {}


def test_a_call_with_no_detail_beside_one_that_has_it_is_left_as_it_was() -> None:
    drawn = render_activity_plan(
        [_call("call-1", "Read a file"), _call("call-2", "Ran the tests")],
        _turn("completed"),
        tool_details={"call-2": "12 passed"},
    )

    assert _card_details(drawn.blocks) == {"Ran the tests": "12 passed"}


# ── Mattermost and Discord: the activity view ────────────────────────────────


def _log(tool_details) -> list[str]:
    return activity_log(
        [_call()],
        _turn("completed"),
        escape=lambda text: text,
        limit=10_000,
        markup=MARKDOWN,
        elapsed_seconds=None,
        heading=False,
        tool_details=tool_details,
    ).splitlines()


def test_the_activity_log_folds_a_calls_detail_onto_its_line() -> None:
    assert _log({"call-1": DETAIL}) == [
        "⌗ ✓ Searched for TODO — $ grep -n TODO src/*.py && echo <done> "
        "src/app.py:12: TODO"
    ]


def test_the_activity_log_shows_no_detail_where_none_is_given() -> None:
    assert _log(NO_TOOL_DETAILS) == ["⌗ ✓ Searched for TODO"]


async def test_mattermosts_activity_view_shows_the_detail_it_was_read_with() -> None:
    adapter, _ = _viewer()

    shown = adapter._activity_text(_snapshot(tool_details={"b": "42 passed in 3s"}))

    assert "Ran the tests — 42 passed — 42 passed in 3s" in shown


# ── Teams and Telegram: none ─────────────────────────────────────────────────


def test_teams_draws_no_detail_whatever_the_room_says() -> None:
    adapter, connector = _teams()
    content = TurnActivity(
        [_call()], _turn("completed"), tool_details={"call-1": DETAIL}
    )

    _run(adapter.post_rich(CHANNEL, AGENT, content, ROOT))

    assert _log_lines(_posted(connector)) == ["⌗ ✓ Searched for TODO"]


async def test_telegram_draws_no_detail_whatever_the_room_says() -> None:
    adapter = _telegram()
    content = TurnActivity(
        [_call()], _turn("completed"), tool_details={"call-1": DETAIL}
    )

    await adapter.post_rich(TELEGRAM_CHANNEL, "my-agent", content, None)

    assert _fold(_sent(adapter)) == ["⌗ ✓ Searched for TODO"]
