"""The log behind a turn's status, for a platform with room for one.

`test_session_turn_status.py` covers the line that sits beside a running turn
and says what it is doing. This is the list behind that line and says what it
did — the same calls Slack already posts into the channel as a message of its
own, so a platform drawing it somewhere narrower is deciding where it is read,
not what is in it.

It also carries what the agent said while it worked, which no conversation ever
sees: the reply reaches the room on its own, and this is the prose around it
that used to exist only in the session. Interleaved with the calls in the order
the turn produced them, because a sentence is usually about the call either
side of it, and behind a disclosure because much of it is the agent narrating
itself rather than telling anyone anything.

Two things it has to get right. It has to fit: the caller gives it one budget
for the whole message and it cannot spend more. And when it does not fit it has
to say so, and say how much — a log that quietly showed its tail reads as a
turn that only made those calls, which is a claim about what the agent did
rather than about how much room there was.
"""

from __future__ import annotations

import re

from switch_core.bridges.collaboration.session.renderers import MARKDOWN
from switch_core.bridges.collaboration.session.renderers.neutral import activity_log
from switch_core.sessions.contract import Item

from .session_fixtures import _item, _turn


def _identity(text: str) -> str:
    return text


def _call(
    status: str = "completed", title: str = "Did a thing", text: str = ""
) -> Item:
    return _item(kind="tool-activity", status=status, title=title, text=text)


def _said(text: str, status: str = "completed") -> Item:
    """Something the agent said: no title, and everything in the text."""
    return _item(kind="assistant-message", status=status, title="", text=text)


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
        heading=heading,
    ).splitlines()


# ── What it shows ────────────────────────────────────────────────────────────


def test_every_call_is_there_oldest_first_under_the_state_line() -> None:
    """Reading order, not recency order: the log is the turn's story, and a
    story told backwards is one a reader has to reassemble."""
    items = [_call(title="First"), _call(title="Second"), _call(title="Third")]

    lines = _log(items)

    assert lines[1:] == ["⌗ ✓ First", "⌗ ✓ Second", "⌗ ✓ Third"]


def test_a_calls_detail_is_not_shown_where_the_platform_did_not_ask_for_it() -> None:
    """The default is no detail at all, not a preview of it. Teams and Telegram
    never promised a reader what a tool took and gave back, and a room opting
    in is what makes `text` non-empty — so a preview here would put it in front
    of readers on a platform that shows no tool detail."""
    lines = _log([_call(title="Ran the tests", text="SECRET 42 passed")])

    assert lines[1:] == ["⌗ ✓ Ran the tests"]
    assert not any("SECRET" in line for line in lines)


def test_how_a_call_went_is_on_the_line_rather_than_left_to_the_tally() -> None:
    """The status line counts failures. The log says which ones."""
    items = [_call(title="Read it"), _call("failed", title="Wrote it")]

    lines = _log(items)

    assert lines[1:] == ["⌗ ✓ Read it", "⌗ ✗ Wrote it"]


def test_a_call_with_no_name_is_shown_rather_than_dropped() -> None:
    """A call the host named nothing is still a call the agent made, and a log
    that silently omitted it would undercount the turn."""
    lines = _log([_call(title="")])

    assert lines[1] == "⌗ ✓ (untitled)"


# ── What the agent said, beside what it did ──────────────────────────────────


def test_what_the_agent_said_sits_where_it_was_said() -> None:
    """The order is the meaning. A sentence collected at one end of the log is
    a sentence a reader has to guess the subject of."""
    items = [
        _call(title="Read the adapter"),
        _said("That test shares a fixture user with the session test."),
        _call(title="Ran the tests"),
    ]

    lines = _log(items)

    assert lines[1:] == [
        "⌗ ✓ Read the adapter",
        "❝ That test shares a fixture user with the session test.",
        "⌗ ✓ Ran the tests",
    ]


def test_a_sentence_is_not_marked_as_a_call_that_succeeded() -> None:
    """Prose has no outcome. Reusing the tick would have every remark read as
    something the agent did and got right."""
    lines = _log([_said("Looking now."), _call(title="Searched")])

    assert lines[1].startswith("❝")
    assert "✓" not in lines[1]


def test_a_paragraph_is_folded_onto_the_one_line_it_is_given() -> None:
    """Every other entry here is one line. A remark spread over four of them is
    indistinguishable from four things having happened."""
    lines = _log([_said("First thought.\n\nSecond thought.\nThird.")])

    assert lines[1:] == ["❝ First thought. Second thought. Third."]


def test_an_item_the_host_has_opened_and_not_filled_is_not_a_line() -> None:
    """A host creates the item before the first token arrives. A marker with
    nothing after it says the agent said something and withholds it."""
    lines = _log([_said(""), _call(title="Searched")])

    assert lines[1:] == ["⌗ ✓ Searched"]


def test_a_turn_that_only_talked_has_a_log_rather_than_nothing() -> None:
    """A turn that answers from what it already knows calls nothing, and used
    to leave a reader who asked what happened with "No activity."."""
    lines = _log([_said("Yes — it was fixed in the merge yesterday.")])

    assert lines[1:] == ["❝ Yes — it was fixed in the merge yesterday."]


def test_a_long_remark_is_cut_like_a_call_is_rather_than_spending_the_log() -> None:
    """One remark is allowed a call's two ceilings and no more. A turn that
    thought aloud at length must not push its own calls out of the log."""
    lines = _log([_said("word " * 400), _call(title="Searched")])

    assert lines[1].endswith("…")
    assert len(lines[1]) <= 2 + 200 + 120
    assert lines[2] == "⌗ ✓ Searched"


def test_a_remark_is_escaped_the_way_a_call_name_is() -> None:
    """It is host text like everything else in here — further from Switch than
    a tool name, if anything, since a model wrote it."""
    lines = activity_log(
        [_said("<b>not bold</b>")],
        _turn("completed"),
        escape=lambda text: text.replace("<", "&lt;"),
        limit=10_000,
        markup=MARKDOWN,
        elapsed_seconds=None,
        heading=False,
    ).splitlines()

    assert lines == ["❝ &lt;b>not bold&lt;/b>"]


def test_the_cut_counts_what_was_said_as_well_as_what_was_done() -> None:
    """The note is the reader's only measure of what they are not seeing, and
    one that counted calls alone would understate it."""
    items = [_said(f"Thought {index}.") for index in range(20)]

    lines = _log(items, limit=120)

    assert lines[1].startswith("…")
    assert "not shown" in lines[1]
    assert lines[-1] == "❝ Thought 19."


def test_a_turn_that_has_ended_with_no_calls_says_it_made_none() -> None:
    assert _log([], "completed")[1] == "No activity."


def test_a_turn_still_running_says_it_has_made_none_yet() -> None:
    """The difference matters: one is a finding about the turn, the other is a
    report about right now."""
    assert _log([], "running")[1] == "No activity yet."


# ── What it does when it will not fit ────────────────────────────────────────


def test_a_log_too_long_for_the_budget_is_cut_at_the_oldest_end() -> None:
    """The newest end is what a reader pressed for."""
    items = [_call(title=f"Call {index}") for index in range(20)]

    lines = _log(items, limit=120)

    assert lines[-1] == "⌗ ✓ Call 19"


def test_a_cut_log_says_how_many_calls_it_is_not_showing() -> None:
    items = [_call(title=f"Call {index}") for index in range(20)]

    lines = _log(items, limit=120)
    shown = [line for line in lines[1:] if line.startswith("⌗")]

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

    assert _log(items, heading=False) == ["⌗ ✓ First", "⌗ ✓ Second"]


def test_declining_the_heading_gives_its_room_back_to_the_calls() -> None:
    """The budget is the whole of what may be spent, so a log with no state
    line to pay for fits more of the turn into the same space."""
    items = [_call(title=f"Call {index}") for index in range(20)]

    with_head = [line for line in _log(items, limit=120)[1:] if line.startswith("⌗")]
    without = [
        line for line in _log(items, limit=120, heading=False) if line.startswith("⌗")
    ]

    assert len(without) > len(with_head)


def test_a_headless_log_with_no_calls_is_still_the_sentence_saying_so() -> None:
    """An empty log is not an empty string. A fold opening onto nothing reads
    as a card that failed to draw."""
    assert _log([], "completed", heading=False) == ["No activity."]


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
        heading=True,
    )

    assert "*not bold*" in seen
    assert "\\*not bold\\*" in drawn


# ── A call's detail, where the platform asks for it ──────────────────────────

# A detail written to get out of its block and do something in the message: an
# early fence, runs of backticks of every length, every mass mention spelling
# the platforms have, a mention, a link and emphasis.
HOSTILE_DETAIL = (
    "```\nrm -rf /\n```\nafter the fence\n"
    "` single `` double ```` four ````` five\n"
    "@channel @here @all @everyone <@123> <!channel>\n"
    "https://evil.example/landing **x**"
)
# What would mean the detail had got out, wherever it showed up outside a block.
HOSTILE_MARKERS = (
    "rm -rf",
    "after the fence",
    "single",
    "@channel",
    "@here",
    "@all",
    "@everyone",
    "<@123>",
    "<!channel>",
    "evil.example",
    "**x**",
)

_FENCE_LINE = re.compile(r" {0,3}`{3,}[ \t]*")

# The line a detail cut again to fit the message ends with, spelled out here
# rather than imported so a change to it is a change a test sees.
SHORTENED = "… (shortened to fit this message)"


def fenced(text: str) -> tuple[list[str], list[str]]:
    """(each block's content, every line outside a block) of a drawn message.

    Read both ways a block can be closed: a line of three or more backticks is
    a fence (CommonMark), and a block's content must hold no three backticks in
    a row anywhere (Discord closes on the first it meets). A block left open is
    a failure, not a reading.
    """
    blocks: list[str] = []
    outside: list[str] = []
    current: list[str] | None = None
    for line in text.split("\n"):
        if _FENCE_LINE.fullmatch(line):
            if current is None:
                current = []
            else:
                blocks.append("\n".join(current))
                current = None
            continue
        (outside if current is None else current).append(line)
    assert current is None, f"a block was left open in {text!r}"
    for block in blocks:
        assert "```" not in block, f"Discord would close this block early: {block!r}"
    return blocks, outside


def _io_log(
    items: list[Item],
    *,
    limit: int = 10_000,
    tool_io_limit: int | None = None,
    escape: object = None,
) -> str:
    return activity_log(
        items,
        _turn("completed"),
        escape=_identity if escape is None else escape,  # type: ignore[arg-type]
        limit=limit,
        markup=MARKDOWN,
        elapsed_seconds=None,
        heading=True,
        tool_io_limit=limit if tool_io_limit is None else tool_io_limit,
    )


def test_a_platform_that_asks_gets_the_detail_as_a_block_under_its_call() -> None:
    lines = _io_log([_call(title="Ran the tests", text="42 passed")]).splitlines()

    assert lines[1:] == ["⌗ ✓ Ran the tests", "```", "42 passed", "```"]


def test_a_detail_cannot_close_its_own_block_or_reach_the_message() -> None:
    """Nothing after the closing fence comes from the detail: every marker is
    inside the one block, read as either parser reads it."""
    drawn = _io_log(
        [_call(title="Ran it", text=HOSTILE_DETAIL), _call(title="Then this")]
    )

    blocks, outside = fenced(drawn)

    assert len(blocks) == 1
    for marker in HOSTILE_MARKERS:
        assert not any(marker in line for line in outside), marker
    for marker in ("@everyone", "<@123>", "<!channel>", "**x**", "after the fence"):
        assert marker in blocks[0], marker
    assert outside[-1] == "⌗ ✓ Then this"


def test_inside_the_block_the_detail_is_literal_and_escaped_once_at_most() -> None:
    """The prose escape is wrong inside a block: a backslash put there for the
    body would show. The title beside it is still prose and still escaped."""

    def _stars(text: str) -> str:
        return text.replace("*", "\\*")

    drawn = _io_log([_call(title="*bold*", text="**x** and _y_")], escape=_stars)

    blocks, outside = fenced(drawn)

    assert blocks == ["**x** and _y_"]
    assert "⌗ ✓ \\*bold\\*" in outside


def test_a_detail_of_nothing_but_space_draws_no_empty_block() -> None:
    drawn = _io_log([_call(title="Ran it", text="  \n\n ")])

    assert fenced(drawn)[0] == []


def test_a_detail_too_long_for_the_message_is_cut_inside_its_block() -> None:
    """The fence is never what runs out: the cut is on the detail, and the
    block is drawn whole around what is kept."""
    drawn = _io_log([_call(title="Ran it", text="x" * 5000)], limit=500)

    blocks, _outside = fenced(drawn)

    assert len(drawn) <= 500
    assert len(blocks) == 1
    assert blocks[0].endswith("\n" + SHORTENED)


def test_no_one_detail_spends_more_than_the_platform_allows_one() -> None:
    drawn = _io_log(
        [_call(title="Ran it", text="x" * 5000)], limit=10_000, tool_io_limit=80
    )

    blocks, _outside = fenced(drawn)

    assert len(blocks) == 1
    assert len("\n```\n" + blocks[0] + "\n```") <= 80


def test_several_details_share_the_budget_and_the_message_still_fits() -> None:
    """CJK and astral text measured as the rest of the message is, smallest
    detail first so a short one is shown whole, and every call kept."""
    items = [
        _call(title=f"Call {index}", text="漢字🙂" * 300 + HOSTILE_DETAIL)
        for index in range(5)
    ] + [_call(title="Short one", text="ok")]

    for limit in (300, 800, 2000, 4000):
        drawn = _io_log(items, limit=limit)

        blocks, outside = fenced(drawn)
        assert len(drawn) <= limit
        drawn.encode("utf-8")
        assert "ok" in blocks
        assert [line for line in outside if line.startswith("⌗")] == [
            *(f"⌗ ✓ Call {index}" for index in range(5)),
            "⌗ ✓ Short one",
        ]
        for block in blocks:
            assert block == "ok" or block.endswith("\n" + SHORTENED)
        for marker in HOSTILE_MARKERS:
            assert not any(marker in line for line in outside), (limit, marker)


def test_a_detail_never_costs_the_log_a_call() -> None:
    """The detail is paid for out of what the lines leave. Where the lines do
    not all fit there is nothing left, and the log is exactly the log a platform
    showing no detail would draw."""
    items = [
        _call(title=f"Call {index} " + "y" * 60, text="z" * 400) for index in range(20)
    ]

    with_io = _io_log(items, limit=400)
    without = _io_log(items, limit=400, tool_io_limit=0)

    assert with_io == without
    assert "z" not in with_io


def _host_detail() -> str:
    """A detail the host clipped to its own 2,000-point cap: 1,997 points, its
    header saying how much of the head and tail it kept, and its own "…" for
    the middle it skipped."""
    head = "\n".join(f"head line {i:03d} " + "." * 39 for i in range(18))[:-62]
    tail = "\n".join(f"tail line {i:03d} " + "." * 39 for i in range(18))
    detail = (
        'Input\n{"command":"make test"}\n\n'
        "Output — clipped: first 909 and last 971 characters shown;"
        " the middle was not kept\n" + head + "\n…\n" + tail
    )
    assert len(detail) == 1997
    return detail


def _cut_again(block: str, source: str) -> None:
    """A detail cut to fit the message: the start kept whole lines at a time,
    the host's header still first, and a last line saying it was shortened —
    never a bare "…" a reader would take for the host's own."""
    kept, _, note = block.rpartition("\n")
    assert note == SHORTENED
    assert block.startswith("Input\n")
    assert source.startswith(kept + "\n")
    assert not block.endswith("\n…")


def test_a_detail_too_long_for_discord_says_it_was_shortened() -> None:
    """The host's own cap is 2,000 points and a Discord message holds 1,978
    here, so a full detail is always cut a second time."""
    detail = _host_detail()

    drawn = _io_log([_call(title="Ran make test", text=detail)], limit=1978)

    blocks, outside = fenced(drawn)
    assert len(drawn) <= 1978
    assert len(blocks) == 1
    assert "⌗ ✓ Ran make test" in outside
    _cut_again(blocks[0], detail)


def test_details_sharing_a_mattermost_message_each_say_they_were_shortened() -> None:
    detail = _host_detail()
    items = [_call(title=f"Ran make test {index}", text=detail) for index in range(3)]

    drawn = _io_log(items, limit=3977)

    blocks, outside = fenced(drawn)
    assert len(drawn) <= 3977
    assert len(blocks) == 3
    assert sum(line.startswith("⌗") for line in outside) == 3
    for block in blocks:
        _cut_again(block, detail)


def test_a_detail_that_is_one_long_line_is_still_cut_with_the_note() -> None:
    drawn = _io_log([_call(title="Ran it", text="x" * 5000)], limit=300)

    blocks, _outside = fenced(drawn)
    assert len(drawn) <= 300
    assert len(blocks) == 1
    kept, _, note = blocks[0].rpartition("\n")
    assert note == SHORTENED
    assert kept and set(kept) == {"x"}


def test_a_detail_with_no_room_for_the_note_is_left_out_rather_than_bare() -> None:
    drawn = _io_log(
        [_call(title="Ran it", text="x" * 5000)], limit=10_000, tool_io_limit=30
    )

    assert fenced(drawn)[0] == []
    assert "x" not in drawn
