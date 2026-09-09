"""A turn, from the recording to the blocks a channel would show.

The slices before this one all end in a card: something a person is asked and
has to answer. This is the other half of what a session does — the reading, the
running, the saying — and it is read rather than answered, so what it has to
get right is different. Nothing here mints a handle, writes a row or resolves a
press. What it must not do is show a turn that did more than it appears to have
done, or put agent-written text somewhere Slack parses as markup.

Driven from `examples.activity.json`, which sits beside `examples.json` because
that file is a byte-identical lift and cannot be edited here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from switch_core.bridges.collaboration.session.contract import Item
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity,
    render_activity_text,
)
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)

REPO_ROOT = Path(__file__).resolve().parents[5]
ACTIVITY_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.activity.json"
)

TURN = "turn-activity"


async def _projection() -> SessionProjection:
    source = FixtureEventSource.from_examples(ACTIVITY_PATH, events=["turnActivity"])
    return await project(source, source.session_id)


async def _items() -> list[Item]:
    return (await _projection()).turn_activity(TURN)


def _item(**fields: object) -> Item:
    """One item, spelled out, for the shapes the recording has no case for."""
    return Item.model_validate(
        {
            "itemId": "item-made-up",
            "turnId": TURN,
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Did a thing",
            "text": "",
            "attachments": [],
            "origin": None,
            "audience": {"kind": "session-members"},
            **fields,
        }
    )


def _blocks(items: list[Item]) -> str:
    return json.dumps(render_activity(items).blocks)


def _context(items: list[Item]) -> str:
    """The disclosure: the last block, where the tool log goes."""
    blocks = render_activity(items).blocks
    assert blocks[-1]["type"] == "context"
    text = blocks[-1]["elements"][0]["text"]
    assert isinstance(text, str)
    return text


# ── What the fold hands the renderer ─────────────────────────────────────────


async def test_the_recorded_turn_folds_to_its_latest_revision_of_each_item() -> None:
    """Five items from ten upserts, each showing where it got to."""
    items = await _items()

    assert [(item.item_id, item.status) for item in items] == [
        ("item-asked", "completed"),
        ("item-search", "completed"),
        ("item-run", "failed"),
        ("item-said", "completed"),
        ("item-write", "in-progress"),
    ]
    assert items[3].text.endswith("Pinning the fixture to one user per test fixes it.")


async def test_an_item_revised_in_place_keeps_the_position_it_opened_in() -> None:
    """Otherwise a tool that takes a minute jumps to the end when it finishes.

    `item-search` opens before `item-run` and is revised after it, so a fold
    that ordered by last touch would print the search below the test run and
    tell the reader the agent searched after it had already run the tests.
    """
    items = await _items()

    assert [item.item_id for item in items].index("item-search") < [
        item.item_id for item in items
    ].index("item-run")


async def test_a_turn_is_only_its_own_items() -> None:
    projection = await _projection()

    assert projection.turn_activity("turn-nobody-ran") == []
    assert len(projection.turn_activity(TURN)) == 5


# ── Saying, and doing ────────────────────────────────────────────────────────


async def test_what_was_said_is_the_body_and_what_was_done_is_the_disclosure() -> None:
    """The split this slice exists for.

    A turn is a paragraph of conversation and a hundred lines of tool calls.
    Drawn the same size, the tool calls are all a reader sees.
    """
    items = await _items()
    blocks = render_activity(items).blocks

    assert [block["type"] for block in blocks] == [
        "section",
        "section",
        "context",
    ]
    assert "flaky all week" in blocks[0]["text"]["text"]
    assert "same fixture user" in blocks[1]["text"]["text"]
    assert "Ran tests/auth/test_login.py" in blocks[2]["elements"][0]["text"]


async def test_the_tool_log_says_how_each_call_went() -> None:
    """A failed call that reads like a completed one is the whole risk here."""
    log = _context(await _items())

    assert "✓ Searched for the login tests — 4 files" in log
    assert "✗ Ran tests/auth/test_login.py — 1 failed, 41 passed" in log
    assert "▸ Editing tests/auth/conftest.py — Waiting for permission" in log


async def test_a_call_still_waiting_does_not_read_as_one_already_refused() -> None:
    """The edit the card underneath is asking about has not been decided.

    A turn saying `⊘` above a card asking whether to allow the same edit tells
    the reader the answer before it asks the question — and tells them the wrong
    one. `declined` is what the answer would make it, not what waiting is.
    """
    log = _context(await _items())

    assert "⊘" not in log
    assert "⊘ Refused it" in _context([_item(status="declined", title="Refused it")])


async def test_a_person_speaking_is_quoted_and_attributed() -> None:
    """In a room this may be the first anyone there has heard of it.

    The contract carries a message typed into the console exactly as it carries
    one typed in the channel, so an unattributed body would read as the agent
    talking to itself.
    """
    blocks = render_activity(await _items()).blocks

    assert blocks[0]["text"]["text"].startswith("> *operator* in Slack: ")
    assert not blocks[1]["text"]["text"].startswith(">")


async def test_the_tool_log_reads_in_the_order_the_work_happened() -> None:
    log = _context(await _items()).splitlines()

    assert [line.split(" ", 1)[1].split(" —")[0] for line in log] == [
        "Searched for the login tests",
        "Ran tests/auth/test_login.py",
        "Editing tests/auth/conftest.py",
    ]


# ── What a host wrote, in somewhere Slack parses ─────────────────────────────


async def test_agent_written_text_cannot_forge_markup() -> None:
    """Every value in a turn is the host's, and both surfaces parse mrkdwn."""
    items = [
        _item(itemId="i1", kind="assistant-message", title="", text="<!channel> now"),
        _item(itemId="i2", title="Ran <!here> --force"),
    ]

    rendered = _blocks(items)

    assert "<!channel>" not in rendered
    assert "<!here>" not in rendered
    assert "&lt;!channel&gt;" in rendered


async def test_a_long_message_is_cut_rather_than_taking_the_post_with_it() -> None:
    """Slack rejects a section over 3000 characters and rejects the whole post.

    A turn is unbounded and a block is not, so the value that overran has to be
    cut here — where it can be cut on the source rather than on the escaped
    form, which would leave half an entity in front of the reader.
    """
    items = [_item(itemId="i1", kind="assistant-message", title="", text="&" * 4000)]

    text = render_activity(items).blocks[0]["text"]["text"]

    assert len(text) <= 2400
    assert text.endswith("…")
    assert "&am" not in text.replace("&amp;", "")


async def test_a_quoted_message_is_budgeted_after_it_is_quoted() -> None:
    """The `> ` costs two characters a line, and lines are not budgeted.

    A message inside its own budget can still overrun the section once quoted,
    and the shape that does it is a pasted stack trace or file listing — which
    is precisely what a person types into a channel. Slack refuses the whole
    post, so the channel gets the card with nothing above it.
    """
    lines = "\n".join(f"line {n}" for n in range(300))
    items = [_item(itemId="i1", kind="user-message", title="", text=lines)]

    text = render_activity(items).blocks[0]["text"]["text"]

    assert len(text) <= 3000
    assert text.startswith("> line 0")
    assert text.endswith("more lines._")


async def test_the_fallback_stays_inside_what_slack_takes_for_one_string() -> None:
    """Twenty messages each inside its own budget still clear the cap on `text`.

    Each block is bounded on its own, but `text` is one string with a limit of
    its own, and a turn that overruns it risks the call taking the whole post
    with it rather than just the notification.
    """
    items = [
        _item(itemId=f"i{n}", kind="assistant-message", title="", text="x" * 2400)
        for n in range(20)
    ]

    text = render_activity_text(items)

    assert len(text) <= 40000
    assert text.splitlines()[0] == "…4 earlier entries, not shown."
    assert text.endswith("x")


async def test_what_the_fallback_dropped_is_counted_in_what_it_dropped() -> None:
    """Entries, not lines: a message is one entry and hundreds of lines.

    Three dropped messages of 250 lines each is 750 lines gone. Reported as
    "3 lines" it reads as a rounding error, and this cut is the only thing
    standing between a turn showing a fraction of itself and a turn appearing
    to have only done that much.
    """
    body = "\n".join("x" * 8 for _ in range(250))
    items = [
        _item(itemId=f"i{n}", kind="assistant-message", title="", text=body)
        for n in range(20)
    ]

    first = render_activity_text(items).splitlines()[0]

    assert first == "…3 earlier entries, not shown."


async def test_a_long_tool_log_keeps_the_recent_end_and_says_what_it_dropped() -> None:
    """The end a reader is looking at, and never a turn quietly halved."""
    items = [_item(itemId=f"i{n}", title=f"Step {n}") for n in range(20)]

    log = _context(items).splitlines()

    assert log[0] == "_…and 8 more before these._"
    assert log[1].endswith("Step 8")
    assert log[-1].endswith("Step 19")


async def test_many_messages_keep_the_recent_end_and_say_what_they_dropped() -> None:
    items = [
        _item(itemId=f"i{n}", kind="assistant-message", title="", text=f"Line {n}")
        for n in range(25)
    ]

    blocks = render_activity(items).blocks

    assert len(blocks) == 21
    assert blocks[0]["elements"][0]["text"] == "_…5 earlier in this turn, not shown._"
    assert blocks[1]["text"]["text"] == "Line 5"


# ── The shapes a host can produce and nobody would choose ────────────────────


async def test_a_turn_with_nothing_in_it_is_refused_rather_than_posted_empty() -> None:
    """A message with no blocks is rejected by Slack and says nothing anyway."""
    with pytest.raises(ValueError, match="nothing to show"):
        render_activity([])
    with pytest.raises(ValueError, match="nothing to show"):
        render_activity_text([])


async def test_an_untitled_tool_call_is_still_a_line() -> None:
    """`title` has no minimum length in either reader, and a blank line in the
    log reads as a call the renderer lost."""
    assert "_(untitled)_" in _context([_item(title="")])


async def test_a_message_with_no_text_says_so() -> None:
    items = [_item(itemId="i1", kind="assistant-message", title="", text="")]

    assert render_activity(items).blocks[0]["text"]["text"] == "_(nothing said)_"


async def test_a_person_the_host_did_not_place_is_quoted_without_a_name() -> None:
    items = [_item(itemId="i1", kind="user-message", title="", text="do it")]

    assert render_activity(items).blocks[0]["text"]["text"] == "> do it"


# ── The notification string ──────────────────────────────────────────────────


async def test_the_text_fallback_carries_the_doing_as_well_as_the_saying() -> None:
    """It is what a reader is left with when blocks do not render.

    A fallback holding only the conversation would drop the whole disclosure
    rather than shrink it, which is the one thing this file is here to prevent.
    """
    text = render_activity_text(await _items())

    assert "flaky all week" in text
    assert "same fixture user" in text
    assert "✗ Ran tests/auth/test_login.py — 1 failed, 41 passed" in text


async def test_the_card_and_its_fallback_say_the_same_things() -> None:
    items = await _items()
    message = render_activity(items)

    assert message.text == render_activity_text(items)


# ── What the contract no longer decides ──────────────────────────────────────


async def test_the_audience_a_host_asked_for_is_not_consulted() -> None:
    """Every tool call in the recording is marked `session-members`.

    All three reach the channel, because who sees a session's activity is
    Switch's decision and not the host's. Nothing has yet been built that takes
    it — the only caller is the demo, which shows the turn to whoever asked for
    it — so this records where the behaviour stands rather than endorsing it as
    the answer. See the PR's risks.
    """
    items = await _items()
    private = [item for item in items if item.audience == {"kind": "session-members"}]

    assert len(private) == 3
    assert all(item.title.split()[0] in _context(items) for item in private)
