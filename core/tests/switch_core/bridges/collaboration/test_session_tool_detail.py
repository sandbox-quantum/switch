"""A tool call's input and output, where a room asked to see them.

The host sends them already redacted and cut to a preview, and the server
draws them in place of the call's text only on a platform that shows them and
while the room has tool detail on. What is pinned here is how each such
platform draws that text: as it was sent, set apart from the call's name, and
never able to break out of the place it is drawn in.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.session.renderers import MARKDOWN, Markup
from switch_core.bridges.collaboration.session.renderers.neutral import activity_log
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity_plan,
)
from switch_core.sessions.contract import Item

from .session_fixtures import _item, _turn

DETAIL = 'Input:\n{\n  "command": "echo `date` && ls"\n}\n\nOutput:\nREADME.md\n\nExit code: 0'


def _call(text: str) -> Item:
    return _item(itemId="call", title="Ran echo", text=text)


def _card(text: str) -> dict[str, Any]:
    [_, card] = render_activity_plan([_call(text)], _turn("completed")).blocks[0][
        "tasks"
    ]
    return card


def _details(card: dict[str, Any]) -> str:
    return card["details"]["elements"][0]["elements"][0]["text"]


def _log(text: str, *, escape=lambda text: text, markup: Markup = MARKDOWN) -> str:
    return activity_log(
        [_call(text)],
        _turn("completed"),
        escape=escape,
        limit=10_000,
        markup=markup,
        elapsed_seconds=None,
        heading=False,
    )


def test_slack_shows_the_detail_in_the_card_as_it_was_sent() -> None:
    """Backticks included: they are part of the command that ran, and a card's
    detail parses no markup that would need them taken out."""
    assert _details(_card(DETAIL)) == DETAIL


def test_slack_cuts_a_detail_longer_than_a_card_takes_and_says_so() -> None:
    shown = _details(_card("x" * 5000))
    assert 2900 < len(shown) <= 3000
    assert shown.endswith("[…truncated]")


def test_the_log_sets_the_detail_apart_under_the_calls_line() -> None:
    assert _log(DETAIL).splitlines()[:2] == ["⌗ ✓ Ran echo", "```"]
    assert _log(DETAIL).endswith(f"\n{DETAIL}\n```")


def test_a_fence_in_the_output_cannot_close_the_block_early() -> None:
    log = _log("Output:\n```\nnot the end\n```")
    assert log.splitlines()[1] == "````"
    assert log.endswith("\n````")


def test_a_long_detail_is_cut_in_the_log() -> None:
    log = _log("Output:\n" + "y" * 4000)
    body = log.split("```")[1]
    assert len(body) <= 2000 + 2
    assert body.rstrip("\n").endswith("…")
