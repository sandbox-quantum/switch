"""The live status line every SDK-publishing platform edits in place.

`test_session_turn_summary.py` covers the other neutral rendering — the one a
platform shows once, after the fact. This is the one that is rewritten while
the turn runs, so what it has to get right is tense: it must never describe a
turn that has ended as though it were still going, and on a platform that does
not report tool activity it must not report it here by the side door.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from switch_core.bridges.agent.commands import TurnIdPrefix, parse_cancel_args
from switch_core.bridges.collaboration.session.renderers import MARKDOWN, Markup
from switch_core.bridges.collaboration.session.renderers.neutral import turn_status
from switch_core.bridges.collaboration.teams.adapter import _TEAMS_MARKUP
from switch_core.bridges.collaboration.telegram.adapter import TELEGRAM_HTML
from switch_core.clients.mentions import mention_tokens
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
        agent_name="cc",
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
        agent_name="cc",
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
    agent_name: str | None = "cc",
    escape: Callable[[str], str] = _identity,
) -> list[str]:
    return turn_status(
        items or [],
        turn,
        escape=escape,
        limit=limit,
        markup=markup,
        elapsed_seconds=elapsed_seconds,
        tool_detail=True,
        agent_name=agent_name,
    ).splitlines()


def _defuse_at(text: str) -> str:
    """What every adapter's escape does to an `@`: a zero-width space after it."""
    return text.replace("@", "@​")


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


# The card as each platform marks a literal, and how a reader's copy of that
# literal comes out: the marks are not copied, the text between them is.
_COMMAND_CARDS = [
    (
        MARKDOWN,
        "`!cancel @cc 3f2b8c1e` — the sender can send this to withdraw it.",
        "`",
    ),
    (
        TELEGRAM_HTML,
        "<code>!cancel @cc 3f2b8c1e</code> — the sender can send this to withdraw it.",
        "<code>",
    ),
    (
        _TEAMS_MARKUP,
        "**!cancel @cc 3f2b8c1e** — the sender can send this to withdraw it.",
        "**",
    ),
]


def _copied(line: str, mark: str) -> str:
    """The literal a reader copies off the line: what the first mark opens."""
    close = mark.replace("<", "</")
    start = line.index(mark) + len(mark)
    return line[start : line.index(close, start)]


@pytest.mark.parametrize(
    ("markup", "hint", "mark"), _COMMAND_CARDS, ids=["markdown", "telegram", "teams"]
)
def test_a_queued_turn_offers_one_command_to_copy(
    markup: Markup, hint: str, mark: str
) -> None:
    """The command is one literal, the agent's mention and the id's first eight
    characters in it, marked the way the platform marks code. The escape every
    adapter applies is passed here and does not reach the literal: it would put
    a zero-width space after the `@`, and the parser finds no mention in that."""
    lines = _drawn(_turn_with_id("queued", QUEUED_ID), markup, escape=_defuse_at)

    assert lines == [markup.bold("Queued. Waiting for the agent to start…"), hint]
    assert "​" not in hint


@pytest.mark.parametrize(
    ("markup", "hint", "mark"), _COMMAND_CARDS, ids=["markdown", "telegram", "teams"]
)
def test_the_copied_command_names_the_turn_and_the_agent(
    markup: Markup, hint: str, mark: str
) -> None:
    """Sent as it was copied, the literal is split the way every platform splits
    a `!` command, and what `!cancel` reads from its args is the turn's start
    and, as its first mention, the agent the card was drawn for."""
    lines = _drawn(_turn_with_id("queued", QUEUED_ID), markup, escape=_defuse_at)

    sent = _copied(lines[1], mark)
    command, args = sent.split(None, 1)

    assert command == "!cancel"
    assert parse_cancel_args(args) == TurnIdPrefix("3f2b8c1e")
    assert mention_tokens(args)[0] == "cc"


@pytest.mark.parametrize(
    ("markup", "hint"),
    [
        (
            MARKDOWN,
            "Turn ID: `3f2b8c1e` — the sender can withdraw it with `!cancel`, "
            "the agent's mention and this ID.",
        ),
        (
            TELEGRAM_HTML,
            "Turn ID: <code>3f2b8c1e</code> — the sender can withdraw it with "
            "<code>!cancel</code>, the agent's mention and this ID.",
        ),
        (
            _TEAMS_MARKUP,
            "Turn ID: **3f2b8c1e** — the sender can withdraw it with **!cancel**, "
            "the agent's mention and this ID.",
        ),
    ],
    ids=["markdown", "telegram", "teams"],
)
@pytest.mark.parametrize(
    "agent_name",
    [None, "all", "two words"],
    ids=["no-agent", "reserved-name", "not-one-mention"],
)
def test_without_a_name_to_mention_the_card_names_the_pieces(
    markup: Markup, hint: str, agent_name: str | None
) -> None:
    """No agent to name, or a name `!cancel` would not read back as the agent's
    one mention: the card does not offer a command that names nobody. The id
    and the command are still literals to copy, each marked its own way, and
    the id is its first eight characters, which `!cancel` takes as they are."""
    lines = _drawn(_turn_with_id("queued", QUEUED_ID), markup, agent_name=agent_name)

    assert lines == [markup.bold("Queued. Waiting for the agent to start…"), hint]
    assert hint == _HINT.format(
        id=markup.code(QUEUED_ID[:8]), cancel=markup.code("!cancel")
    )
    assert parse_cancel_args(f"@cc {QUEUED_ID[:8]}") == TurnIdPrefix("3f2b8c1e")
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
