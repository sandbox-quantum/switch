"""The live status line every SDK-publishing platform edits in place.

`test_session_turn_summary.py` covers the other neutral rendering — the one a
platform shows once, after the fact. This is the one that is rewritten while
the turn runs, so what it has to get right is tense: it must never describe a
turn that has ended as though it were still going, and on a platform that does
not report tool activity it must not report it here by the side door.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.session.renderers import MARKDOWN
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.sessions.contract import Item

from .session_fixtures import _item, _turn

_URL = "https://console.example/session/s"


def _identity(text: str) -> str:
    return text


def _call(status: str, title: str = "Did a thing") -> Item:
    return _item(kind="tool-activity", status=status, title=title)


def _status(items: list[Item], turn_state: str, *, tool_detail: bool) -> list[str]:
    return turn_status(
        items,
        _turn(turn_state),
        escape=_identity,
        limit=10_000,
        markup=MARKDOWN,
        tool_detail=tool_detail,
    ).splitlines()


# ── A turn that has ended is not still running ────────────────────────────────


def test_a_call_the_host_never_closed_is_not_counted_as_running_after_the_end() -> None:
    """The item keeps the status the host gave it; the tally stops repeating it.

    "▸ 1 running" under a headline saying the turn is over describes a turn
    nobody has. What the turn left behind is the state line's to say, in the
    tense that belongs to it.
    """
    items = [_call("failed"), _call("in-progress")]

    lines = _status(items, "completed", tool_detail=True)

    assert lines == ["**Turn complete. 1 step left unfinished.**", "✗ 1 failed"]


def test_an_ended_turn_with_nothing_wrong_reports_no_tally_at_all() -> None:
    """The state line already gave the total, so a second count adds nothing."""
    items = [_call("completed"), _call("completed")]

    lines = _status(items, "completed", tool_detail=True)

    assert lines == ["**Turn complete.**"]


def test_a_running_turn_still_says_what_is_running() -> None:
    """The present tense is only wrong once the turn is over."""
    items = [_call("completed"), _call("in-progress", title="Reading a file")]

    lines = _status(items, "running", tool_detail=True)

    assert lines == ["**Working…**", "Now: Reading a file", "▸ 1 running · ✓ 1 done"]


# ── A platform that does not report tool activity ─────────────────────────────


def test_healthy_calls_are_not_reported_where_tool_activity_is_not() -> None:
    """No line of the moment, and no count of calls that went fine."""
    items = [_call("completed"), _call("in-progress", title="Reading a file")]

    lines = _status(items, "running", tool_detail=False)

    assert lines == ["**Working…**"]


def test_a_call_that_failed_is_reported_even_there() -> None:
    """An outcome somebody has to act on is not progress chatter."""
    items = [_call("completed"), _call("failed"), _call("declined")]

    lines = _status(items, "running", tool_detail=False)

    assert lines == ["**Working…**", "✗ 1 failed · ⊘ 1 declined"]


# ── The message a problem gets of its own ─────────────────────────────────────


def _attention(summary: str, *, limit: int) -> list[str]:
    return turn_status(
        [],
        _turn("error"),
        escape=_identity,
        limit=limit,
        markup=MARKDOWN,
        session_url=_URL,
        error_summary=summary,
        tool_detail=True,
    ).splitlines()


def test_the_warning_carries_the_link_to_what_the_turn_was_doing() -> None:
    """The one message a reader is asked to act on says where to look.

    It is drawn from no items, so there is no log on it and nothing to expand:
    the link is the whole of the answer to what the session was doing when it
    went wrong, and a warning without it asks somebody to act on a sentence.
    """
    lines = _attention("The host is offline.", limit=10_000)

    assert lines == [f"⚠️ The host is offline. · [Open in Switch Console]({_URL})"]


def test_a_warning_with_no_room_beside_it_keeps_the_warning() -> None:
    """What went wrong outranks where to read about it when only one fits."""
    lines = _attention("The host is offline.", limit=30)

    assert lines == ["⚠️ The host is offline."]
