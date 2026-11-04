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
        error_summary=summary,
        tool_detail=True,
    ).splitlines()


def test_the_warning_is_the_whole_message() -> None:
    lines = _attention("The host is offline.", limit=10_000)

    assert lines == ["⚠️ The host is offline."]


def test_a_warning_too_long_for_the_message_is_cut() -> None:
    lines = _attention("The host is offline.", limit=10)

    assert len(lines) == 1
    assert len(lines[0]) <= 10
    assert lines[0].startswith("⚠️")


# ── Queued turns and message edits ───────────────────────────────────────────


def test_queued_turn_with_original_user_message() -> None:
    """An unedited message in queue shows standard queued status."""
    items = [_item(kind="user-message", revision=1)]

    lines = _status(items, "queued", tool_detail=True)

    assert lines == ["**Queued. Waiting for the agent to start…**"]


def test_queued_turn_with_edited_user_message_shows_queued_edited() -> None:
    """An edited message in queue shows Queued (edited)."""
    items = [_item(kind="user-message", revision=2)]

    lines = _status(items, "queued", tool_detail=True)

    assert lines == ["**Queued (edited). Waiting for the agent to start…**"]


def test_status_state_reflects_user_message_revision() -> None:
    """Advancing the user message revision produces a distinct status_state to trigger redraw."""
    from datetime import UTC, datetime
    from unittest.mock import MagicMock

    from switch_core.session_activity.bridge_turns import TurnView, status_state

    row = MagicMock()
    now = datetime.now(UTC)

    view_v1 = TurnView(
        turn=_turn("queued"),
        items=[_item(kind="user-message", revision=1)],
        row=row,
        started_at=now,
    )
    view_v2 = TurnView(
        turn=_turn("queued"),
        items=[_item(kind="user-message", revision=2)],
        row=row,
        started_at=now,
    )

    state_v1 = status_state(
        view_v1,
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )
    state_v2 = status_state(
        view_v2,
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )

    assert state_v1 != state_v2
    assert state_v1 == "queued::/:1"
    assert state_v2 == "queued::/:2"
