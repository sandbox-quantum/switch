"""The live status line every SDK-publishing platform edits in place.

`test_session_turn_summary.py` covers the other neutral rendering — the one a
platform shows once, after the fact. This is the one that is rewritten while
the turn runs, so what it has to get right is tense: it must never describe a
turn that has ended as though it were still going, and on a platform that does
not report tool activity it must not report it here by the side door.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.session.renderers import MARKDOWN, Markup
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.bridges.collaboration.teams.adapter import _TEAMS_MARKUP
from switch_core.bridges.collaboration.telegram.adapter import TELEGRAM_HTML
from switch_core.sessions.contract import Item, TurnUpsert

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


# ── A turn withdrawn before it started, and how to withdraw one ──────────────

# A turn id as the host mints it for a room message: the id `!cancel` takes.
QUEUED_ID = "3f2b8c1e-5d4a-5b6c-9e7f-0a1b2c3d4e5f"
_HINT = (
    "Turn ID: {id} — the sender can withdraw it with {cancel}, "
    "the agent's mention and this ID."
)


def _turn_with_id(status: str, turn_id: str) -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": turn_id, "status": status, "commandId": None}
    )


def _drawn(
    turn: TurnUpsert,
    markup: Markup,
    *,
    items: list[Item] | None = None,
    elapsed_seconds: float | None = None,
    limit: int = 10_000,
) -> list[str]:
    return turn_status(
        items or [],
        turn,
        escape=_identity,
        limit=limit,
        markup=markup,
        elapsed_seconds=elapsed_seconds,
        tool_detail=True,
    ).splitlines()


@pytest.mark.parametrize(
    ("markup", "head"),
    [
        (MARKDOWN, "**Cancelled before the agent started.**"),
        (TELEGRAM_HTML, "<b>Cancelled before the agent started.</b>"),
        (_TEAMS_MARKUP, "**Cancelled before the agent started.**"),
    ],
    ids=["markdown", "telegram", "teams"],
)
def test_a_cancelled_turn_says_so_and_nothing_about_time(
    markup: Markup, head: str
) -> None:
    """It never ran: no "Worked for", no step left open, no hint to withdraw it.

    A caller that measured something passes it anyway — the time between the
    turn's rows is how long it waited — and the line still says only that.
    """
    lines = _drawn(
        _turn_with_id("cancelled", QUEUED_ID),
        markup,
        items=[_call("in-progress")],
        elapsed_seconds=125,
    )

    assert lines == [head]


@pytest.mark.parametrize(
    ("markup", "hint"),
    [
        (MARKDOWN, _HINT.format(id=f"`{QUEUED_ID}`", cancel="`!cancel`")),
        (
            TELEGRAM_HTML,
            _HINT.format(id=f"<code>{QUEUED_ID}</code>", cancel="<code>!cancel</code>"),
        ),
        (_TEAMS_MARKUP, _HINT.format(id=f"**{QUEUED_ID}**", cancel="**!cancel**")),
    ],
    ids=["markdown", "telegram", "teams"],
)
def test_a_queued_turn_names_its_id_marked_the_way_the_platform_marks_code(
    markup: Markup, hint: str
) -> None:
    """The id and the command are literals to copy, so each platform marks them
    its own way — a backtick written into the wording would reach Telegram and
    Teams as a backtick."""
    lines = _drawn(_turn_with_id("queued", QUEUED_ID), markup)

    assert lines == [markup.bold("Queued. Waiting for the agent to start…"), hint]
    assert not lines[1].startswith("!")
    assert "@" not in lines[1]


def test_a_follow_up_the_host_queued_itself_offers_nothing_to_withdraw() -> None:
    """Nobody sent it and `!cancel` cannot name it, so no hint."""
    lines = _drawn(_turn_with_id("queued", f"{QUEUED_ID}:followup"), MARKDOWN)

    assert lines == ["**Queued. Waiting for the agent to start…**"]


def test_the_hint_goes_once_the_turn_starts() -> None:
    lines = _drawn(_turn_with_id("running", QUEUED_ID), MARKDOWN)

    assert lines == ["**Working…**"]


def test_the_hint_is_left_out_rather_than_cut_when_there_is_no_room() -> None:
    """The state is what has to survive; a half-printed id is one nobody can use."""
    head = "**Queued. Waiting for the agent to start…**"

    lines = _drawn(_turn_with_id("queued", QUEUED_ID), MARKDOWN, limit=len(head) + 10)

    assert lines == [head]
