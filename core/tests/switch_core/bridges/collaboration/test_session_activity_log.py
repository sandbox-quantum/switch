"""The per-call log behind a turn's status, for a platform with room for one.

`test_session_turn_status.py` covers the line that sits beside a running turn
and says what it is doing. This is the list behind that line and says what it
did — the same calls Slack already posts into the channel as a message of its
own, so a platform drawing it somewhere narrower is deciding where it is read,
not what is in it.

Two things it has to get right. It has to fit: the caller gives it one budget
for the whole message and it cannot spend more. And when it does not fit it has
to say so, and say how much — a log that quietly showed its tail reads as a
turn that only made those calls, which is a claim about what the agent did
rather than about how much room there was.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.session.renderers import MARKDOWN
from switch_core.bridges.collaboration.session.renderers.neutral import activity_log
from switch_core.sessions.contract import Item

from .test_session_activity import _item, _turn


def _identity(text: str) -> str:
    return text


def _call(
    status: str = "completed", title: str = "Did a thing", text: str = ""
) -> Item:
    return _item(kind="tool-activity", status=status, title=title, text=text)


def _log(
    items: list[Item],
    turn_state: str = "completed",
    *,
    limit: int = 10_000,
    heading: bool = True,
) -> list[str]:
    return activity_log(
        items,
        _turn(turn_state),
        escape=_identity,
        limit=limit,
        markup=MARKDOWN,
        elapsed_seconds=None,
        session_url=None,
        heading=heading,
    ).splitlines()


# ── What it shows ────────────────────────────────────────────────────────────


def test_every_call_is_there_oldest_first_under_the_state_line() -> None:
    """Reading order, not recency order: the log is the turn's story, and a
    story told backwards is one a reader has to reassemble."""
    items = [_call(title="First"), _call(title="Second"), _call(title="Third")]

    lines = _log(items)

    assert lines[1:] == ["✓ First", "✓ Second", "✓ Third"]


def test_a_call_that_said_something_says_it_beside_the_name() -> None:
    lines = _log([_call(title="Ran the tests", text="42 passed")])

    assert lines[1] == "✓ Ran the tests — 42 passed"


def test_how_a_call_went_is_on_the_line_rather_than_left_to_the_tally() -> None:
    """The status line counts failures. The log says which ones."""
    items = [_call(title="Read it"), _call("failed", title="Wrote it")]

    lines = _log(items)

    assert lines[1:] == ["✓ Read it", "✗ Wrote it"]


def test_a_call_with_no_name_is_shown_rather_than_dropped() -> None:
    """A call the host named nothing is still a call the agent made, and a log
    that silently omitted it would undercount the turn."""
    lines = _log([_call(title="")])

    assert lines[1] == "✓ (untitled)"


def test_only_tool_calls_are_in_the_tool_log() -> None:
    """What the agent said belongs to the conversation, not to this."""
    items = [
        _item(kind="assistant-message", title="", text="Looking now."),
        _call(title="Searched"),
    ]

    lines = _log(items)

    assert lines[1:] == ["✓ Searched"]


def test_a_turn_that_has_ended_with_no_calls_says_it_made_none() -> None:
    assert _log([], "completed")[1] == "No tool calls."


def test_a_turn_still_running_says_it_has_made_none_yet() -> None:
    """The difference matters: one is a finding about the turn, the other is a
    report about right now."""
    assert _log([], "running")[1] == "No tool calls yet."


# ── What it does when it will not fit ────────────────────────────────────────


def test_a_log_too_long_for_the_budget_is_cut_at_the_oldest_end() -> None:
    """The newest end is what a reader pressed for."""
    items = [_call(title=f"Call {index}") for index in range(20)]

    lines = _log(items, limit=120)

    assert lines[-1] == "✓ Call 19"


def test_a_cut_log_says_how_many_calls_it_is_not_showing() -> None:
    items = [_call(title=f"Call {index}") for index in range(20)]

    lines = _log(items, limit=120)
    shown = [line for line in lines[1:] if line.startswith("✓")]

    assert lines[1] == f"…{20 - len(shown)} earlier in this turn, not shown."


def test_the_whole_thing_stays_inside_the_budget_it_was_given() -> None:
    """One message is all the platform has. A log that overran it would be a
    post the platform refuses, which is a button that does nothing."""
    items = [_call(title=f"Call {index} " + "x" * 400) for index in range(40)]

    for limit in (80, 200, 1000, 2000):
        assert len("\n".join(_log(items, limit=limit))) <= limit


def test_a_budget_too_small_for_even_one_call_still_says_there_were_calls() -> None:
    """Better a line saying the log did not fit than a log claiming the turn
    made no calls."""
    items = [_call(title="Call " + "x" * 400) for _ in range(3)]

    lines = _log(items, limit=60)

    assert lines[-1] == "…3 earlier in this turn, not shown."


def test_one_long_call_is_shortened_rather_than_dropped() -> None:
    """A single call longer than the whole budget is still the thing the reader
    came for."""
    lines = _log([_call(title="Grepped for " + "x" * 5000)], limit=300)

    assert len("\n".join(lines)) <= 300
    assert "Grepped for" in lines[-1]


# ── Where something above it already names the turn ──────────────────────────


def test_a_log_that_declines_the_heading_starts_at_the_first_call() -> None:
    """Teams folds the log away directly under the status line, which already
    carries the state and the Console link. Printing them again as the log's
    first line is the card showing one sentence twice."""
    items = [_call(title="First"), _call(title="Second")]

    assert _log(items, heading=False) == ["✓ First", "✓ Second"]


def test_declining_the_heading_gives_its_room_back_to_the_calls() -> None:
    """The budget is the whole of what may be spent, so a log with no state
    line to pay for fits more of the turn into the same space."""
    items = [_call(title=f"Call {index}") for index in range(20)]

    with_head = [line for line in _log(items, limit=120)[1:] if line.startswith("✓")]
    without = [
        line for line in _log(items, limit=120, heading=False) if line.startswith("✓")
    ]

    assert len(without) > len(with_head)


def test_a_headless_log_with_no_calls_is_still_the_sentence_saying_so() -> None:
    """An empty log is not an empty string. A fold opening onto nothing reads
    as a card that failed to draw."""
    assert _log([], "completed", heading=False) == ["No tool calls."]


def test_a_link_handed_to_a_headless_log_is_refused_rather_than_dropped() -> None:
    """There is nowhere to put it once the state line is gone, and a caller who
    thinks they published a Console link and did not is worse off than one told
    they asked for something impossible."""
    with pytest.raises(ValueError, match="nowhere to put the Console link"):
        activity_log(
            [_call()],
            _turn("completed"),
            escape=_identity,
            limit=10_000,
            markup=MARKDOWN,
            elapsed_seconds=None,
            session_url="https://console.example.test/s/1",
            heading=False,
        )


def test_a_headless_log_stays_inside_the_budget_it_was_given() -> None:
    items = [_call(title=f"Call {index} " + "x" * 400) for index in range(40)]

    for limit in (80, 200, 1000, 2000):
        assert len("\n".join(_log(items, limit=limit, heading=False))) <= limit


# ── What it is drawn with ────────────────────────────────────────────────────


def test_host_text_is_put_through_the_platforms_own_escape() -> None:
    """Every title and detail came from a host and is host text."""
    seen: list[str] = []

    def _record(text: str) -> str:
        seen.append(text)
        return text.replace("*", "\\*")

    drawn = activity_log(
        [_call(title="*not bold*", text="_nor this_")],
        _turn("completed"),
        escape=_record,
        limit=10_000,
        markup=MARKDOWN,
        elapsed_seconds=None,
        session_url=None,
        heading=True,
    )

    assert "*not bold*" in seen
    assert "\\*not bold\\*" in drawn


def test_the_console_link_rides_on_the_state_line_when_there_is_room() -> None:
    drawn = activity_log(
        [_call()],
        _turn("completed"),
        escape=_identity,
        limit=10_000,
        markup=MARKDOWN,
        elapsed_seconds=None,
        session_url="https://console.example.test/s/1",
        heading=True,
    )

    assert "https://console.example.test/s/1" in drawn.splitlines()[0]


def test_a_link_that_would_not_fit_is_left_off_rather_than_cut_in_half() -> None:
    """Half a URL is not a link, and the state line is what the reader needs."""
    drawn = activity_log(
        [_call()],
        _turn("completed"),
        escape=_identity,
        limit=40,
        markup=MARKDOWN,
        elapsed_seconds=None,
        session_url="https://console.example.test/" + "s" * 200,
        heading=True,
    )

    assert "console.example.test" not in drawn
