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
from typing import Any

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.bridges.collaboration.session.contract import (
    ApprovalContent,
    ApprovalOption,
    Item,
    SnapshotRequest,
    TurnUpsert,
)
from switch_core.bridges.collaboration.session.projection import SessionProjection
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    turn_state,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity,
    render_activity_text,
    render_request,
    render_turn_with_request,
)
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)

REPO_ROOT = Path(__file__).resolve().parents[5]
ACTIVITY_PATH = (
    REPO_ROOT / "console/packages/shared/src/session-v1/examples.activity.json"
)
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

TURN = "turn-activity"


async def _projection(*streams: str) -> SessionProjection:
    source = FixtureEventSource.from_examples(
        ACTIVITY_PATH, events=streams or ("turnActivity",)
    )
    return await project(source, source.session_id)


async def _items() -> list[Item]:
    return (await _projection()).turn_activity(TURN)


def _turn(status: str = "running") -> TurnUpsert:
    """The turn itself, which is what says whether any of this is still moving."""
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": TURN, "status": status, "commandId": None}
    )


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
            **fields,
        }
    )


def _blocks(items: list[Item]) -> str:
    return json.dumps(render_activity(items, _turn()).blocks)


def _plan(items: list[Item]) -> dict[str, Any]:
    """The disclosure, where the tool log goes: a card per call, collapsed."""
    block = render_activity(items, _turn()).blocks[-1]
    assert block["type"] == "plan"
    return block


def _cards(items: list[Item]) -> dict[str, dict[str, Any]]:
    """The plan's tasks by title, which is what a reader picks one out by."""
    return {str(task["title"]): task for task in _plan(items)["tasks"]}


def _detail(task: dict[str, Any]) -> str:
    """A card's detail, out of the rich-text block it has to be wrapped in."""
    section = task["details"]["elements"][0]
    text = section["elements"][0]["text"]
    assert isinstance(text, str)
    return text


def _state(items: list[Item], turn: TurnUpsert) -> str:
    """Where the turn itself got to: the plan's header, or its own line."""
    block = render_activity(items, turn).blocks[-1]
    if block["type"] == "plan":
        return str(block["title"])
    text = block["elements"][0]["text"]
    assert isinstance(text, str)
    return text


# ── What the fold hands the renderer ─────────────────────────────────────────


async def test_the_recorded_turn_folds_to_its_latest_revision_of_each_item() -> None:
    """Eleven items from twenty-one upserts, each showing where it got to."""
    items = await _items()

    assert [(item.item_id, item.status) for item in items] == [
        ("item-asked", "completed"),
        ("item-search", "completed"),
        ("item-read-test", "completed"),
        ("item-read-conftest", "completed"),
        ("item-grep", "completed"),
        ("item-suite", "failed"),
        ("item-run", "failed"),
        ("item-read-session", "completed"),
        ("item-blame", "declined"),
        ("item-said", "completed"),
        ("item-write", "in-progress"),
    ]
    said = next(item for item in items if item.item_id == "item-said")
    assert said.text.endswith("Pinning the fixture to one user per test fixes it.")


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
    assert len(projection.turn_activity(TURN)) == 11


async def test_the_recording_says_where_its_turn_got_to() -> None:
    """The turn's own state, which is a separate upsert from any of its items."""
    running = await _projection()
    stopped = await _projection("turnActivity", "turnEnd")

    assert running.turn(TURN) is not None
    assert running.turn(TURN).status == "running"  # type: ignore[union-attr]
    assert stopped.turn(TURN).status == "interrupted"  # type: ignore[union-attr]
    assert stopped.turn("turn-nobody-ran") is None


async def test_the_end_of_the_recording_closes_the_request_it_was_waiting_on() -> None:
    """Interrupted with the permission unanswered, which is why the edit hangs."""
    stopped = await _projection("turnActivity", "turnEnd")
    request = stopped.request("request-activity")

    assert request is not None
    assert (request.state, request.result.outcome) == (  # type: ignore[union-attr]
        "closed",
        "interrupted",
    )
    assert stopped.open_requests() == []
    assert [item.status for item in stopped.turn_activity(TURN)][-1] == "in-progress"


# ── Saying, and doing ────────────────────────────────────────────────────────


async def test_what_was_said_is_the_body_and_what_was_done_is_the_disclosure() -> None:
    """The split this slice exists for.

    A turn is a paragraph of conversation and a hundred lines of tool calls.
    Drawn the same size, the tool calls are all a reader sees.
    """
    items = await _items()
    blocks = render_activity(items, _turn()).blocks

    assert [block["type"] for block in blocks] == ["section", "plan"]
    assert "same fixture user" in blocks[0]["text"]["text"]
    assert "Ran tests/auth/test_login.py" in json.dumps(blocks[1], ensure_ascii=False)


async def test_the_tool_log_says_how_each_call_went() -> None:
    """A failed call that reads like a completed one is the whole risk here."""
    cards = _cards(await _items())

    searched = cards["Searched for the login tests"]
    assert searched["status"] == "complete"
    assert _detail(searched).startswith("4 files")
    ran = cards["✗ Ran tests/auth/test_login.py"]
    assert ran["status"] == "error"
    assert _detail(ran).startswith("1 failed, 41 passed")
    editing = cards["Editing tests/auth/conftest.py"]
    assert editing["status"] == "in_progress"
    assert _detail(editing) == "Waiting for permission"


async def test_a_call_still_waiting_does_not_read_as_one_already_refused() -> None:
    """The edit the card underneath is asking about has not been decided.

    A turn saying `⊘` above a card asking whether to allow the same edit tells
    the reader the answer before it asks the question — and tells them the wrong
    one. `declined` is what the answer would make it, not what waiting is.
    """
    titles = list(_cards(await _items()))
    waiting = [title for title in titles if "Editing tests/auth/conftest.py" in title]

    assert waiting == ["Editing tests/auth/conftest.py"]
    refused = _plan([_item(status="declined", title="Refused it")])["tasks"][0]
    assert refused["title"] == "⊘ Refused it"
    assert refused["status"] == "error"


async def test_a_persons_message_is_not_shown_in_the_turn_at_all() -> None:
    """A turn always opens with one: the command that started it, echoed back
    as its first item. Showing it in the room it was typed in is only ever
    telling someone what they just said, so it is skipped rather than quoted.
    """
    items = await _items()
    said = [item for item in items if item.kind == "user-message"]
    assert said, "the fixture must still carry one for this to test anything"

    blocks = render_activity(items, _turn()).blocks

    text = json.dumps(blocks, ensure_ascii=False)
    assert said[0].text not in text
    assert not blocks[0]["text"]["text"].startswith(">")


async def test_the_tool_log_reads_in_the_order_the_work_happened() -> None:
    assert list(_cards(await _items())) == [
        "Searched for the login tests",
        "Read(tests/auth/test_login.py)",
        "Read(tests/auth/conftest.py)",
        "Grep(fixture_user)",
        "✗ Bash(uv run --project core pytest core/tests/switch_core/bridges/"
        "collaboration/test_session_login_fixture_isolation.py -x -q --no-header)",
        "✗ Ran tests/auth/test_login.py",
        "Read(tests/session/test_session.py)",
        "⊘ Bash(git log -L :fixture_user:tests/auth/conftest.py)",
        "Editing tests/auth/conftest.py",
    ]


# ── Where the turn itself got to ─────────────────────────────────────────────


async def test_the_last_line_says_whether_the_turn_is_still_moving() -> None:
    """One message per turn, edited in place, so the message has to say.

    Without it a turn that finished and a turn that died look the same: the
    same tool log, the same last line, and nothing to tell them apart.
    """
    items = await _items()

    assert _state(items, _turn("running")) == "Working…"
    assert _state(items, _turn("queued")) == "Queued."


async def test_a_turn_with_nothing_done_in_it_still_says_where_it_got_to() -> None:
    """No tool calls is no plan, and the header is part of the plan."""
    items = [_item(itemId="i1", kind="assistant-message", title="", text="Hello")]

    assert _state(items, _turn("completed")) == "_Turn complete._"


async def test_a_turn_that_stopped_with_a_step_open_says_what_it_left() -> None:
    """The recording's edit is still waiting on the permission nobody gave.

    Its `▸` is the last thing the host said about that call and stays as it is,
    because the host is the only thing that knows how the call really ended.
    What must not stay is the impression that it is still running.
    """
    items = await _items()

    assert _state(items, _turn("interrupted")) == (
        "Turn interrupted. 1 step left unfinished."
    )
    assert _state(items, _turn("error")) == (
        "Turn ended with an error. 1 step left unfinished."
    )


async def test_a_turn_that_finished_everything_it_started_says_only_that() -> None:
    items = [_item(itemId="i1", status="completed", title="Ran the tests")]

    assert _state(items, _turn("completed")) == "Turn complete."


async def test_a_running_turn_is_not_told_off_for_work_still_in_flight() -> None:
    """Counting unfinished steps before the turn ends is counting the present."""
    items = [_item(itemId="i1", status="in-progress", title="Running the tests")]

    assert _state(items, _turn("running")) == "Working…"


async def test_more_than_one_unfinished_step_is_counted_as_more_than_one() -> None:
    items = [
        _item(itemId=f"i{n}", status="in-progress", title=f"Step {n}") for n in range(3)
    ]

    assert _state(items, _turn("interrupted")).endswith("3 steps left unfinished.")


async def test_the_fallback_carries_the_turn_state_too() -> None:
    """It is the whole message on a client that will not render blocks."""
    text = render_activity_text(await _items(), _turn("completed"))

    assert text.splitlines()[-1] == "Turn complete. 1 step left unfinished."


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

    text = render_activity(items, _turn()).blocks[0]["text"]["text"]

    assert len(text) <= 2400
    assert text.endswith("…")
    assert "&am" not in text.replace("&amp;", "")


async def test_a_turn_with_only_a_persons_message_shows_its_state_not_the_message() -> (
    None
):
    """Every turn opens this way: the command that started it, and nothing
    from the agent yet. Filtering the person's message out of `said` must not
    make this look like a turn with nothing in it at all — it still has a
    state to show, the same as a turn with no tool calls does.
    """
    items = [_item(itemId="i1", kind="user-message", title="", text="do it")]

    blocks = render_activity(items, _turn()).blocks

    assert len(blocks) == 1
    assert blocks[0]["type"] == "context"


async def test_a_turn_with_no_items_at_all_shows_its_state_too() -> None:
    """The normal first moment of every turn: `turn.upsert` always arrives
    before the item that echoes the command which started it, so a turn can
    be published with items still empty. That must render, not raise — the
    publisher wakes on every event, so this is not a rare race to guard
    against, it is what a fresh turn looks like for one event's worth of time.
    """
    blocks = render_activity([], _turn()).blocks

    assert len(blocks) == 1
    assert blocks[0]["type"] == "context"
    assert render_activity_text([], _turn()) == "Working…"


# ── How long it worked ────────────────────────────────────────────────────────


async def test_a_completed_turn_shows_how_long_it_worked_instead_of_saying_so() -> None:
    state = turn_state([], _turn("completed"), elapsed_seconds=80)

    assert state == "Worked for 1m 20s."


async def test_the_worked_for_line_counts_its_tool_calls() -> None:
    did = [_item(itemId=f"c{n}") for n in range(20)]

    state = turn_state(did, _turn("completed"), elapsed_seconds=80)

    assert state == "Worked for 1m 20s. 20 tool calls."


async def test_a_single_tool_call_is_not_pluralised() -> None:
    state = turn_state([_item()], _turn("completed"), elapsed_seconds=5)

    assert state == "Worked for 5s. 1 tool call."


async def test_an_interrupted_turn_keeps_its_own_phrase_and_says_how_long_too() -> None:
    """Worth knowing on its own, unlike "complete" — so this one is appended
    rather than replaced."""
    state = turn_state([], _turn("interrupted"), elapsed_seconds=45)

    assert state == "Turn interrupted. Worked for 45s."


async def test_a_running_turn_ignores_elapsed_seconds() -> None:
    """A running turn's own line is not final, so a duration would be wrong
    the moment it was drawn — this only ever applies once a turn has ended."""
    state = turn_state([], _turn("running"), elapsed_seconds=80)

    assert state == "Working…"


async def test_with_no_elapsed_seconds_a_completed_turn_says_only_that() -> None:
    """No timing to show is not the same as zero — the plain phrase stays
    rather than claiming a duration nobody measured."""
    state = turn_state([], _turn("completed"), elapsed_seconds=None)

    assert state == "Turn complete."


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

    text = render_activity_text(items, _turn())

    assert len(text) <= 40000
    assert text.splitlines()[0] == "…4 earlier entries, not shown."
    assert text.splitlines()[-1] == "Working…"


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

    first = render_activity_text(items, _turn()).splitlines()[0]

    assert first == "…3 earlier entries, not shown."


async def test_a_long_tool_log_keeps_the_recent_end_and_says_what_it_dropped() -> None:
    """The end a reader is looking at, and never a turn quietly halved.

    Slack takes 50 cards in a plan, so the recording's twenty all fit; the cut
    is asserted on the fallback string, which keeps twelve.
    """
    items = [_item(itemId=f"i{n}", title=f"Step {n}") for n in range(20)]

    assert list(_cards(items)) == [f"Step {n}" for n in range(20)]

    log = render_activity_text(items, _turn()).splitlines()
    assert log[0] == "_…and 8 more before these._"
    assert log[1].endswith("Step 8")
    assert log[-2].endswith("Step 19")


async def test_a_plan_longer_than_slack_takes_is_cut_in_its_header() -> None:
    """Slack rejects a plan over fifty tasks, and takes the whole post with it."""
    items = [_item(itemId=f"i{n}", title=f"Step {n}") for n in range(60)]

    plan = _plan(items)

    assert len(plan["tasks"]) == 50
    assert plan["title"] == "Working… …10 earlier steps, not shown."
    assert plan["tasks"][0]["title"] == "Step 10"


async def test_many_messages_keep_the_recent_end_and_say_what_they_dropped() -> None:
    items = [
        _item(itemId=f"i{n}", kind="assistant-message", title="", text=f"Line {n}")
        for n in range(25)
    ]

    blocks = render_activity(items, _turn()).blocks

    assert len(blocks) == 22
    assert blocks[0]["elements"][0]["text"] == "_…5 earlier in this turn, not shown._"
    assert blocks[1]["text"]["text"] == "Line 5"


# ── The shapes a host can produce and nobody would choose ────────────────────


async def test_an_untitled_tool_call_is_still_a_line() -> None:
    """`title` has no minimum length in either reader, and a blank line in the
    log reads as a call the renderer lost."""
    assert list(_cards([_item(title="")])) == ["(untitled)"]


async def test_a_message_with_no_text_says_so() -> None:
    items = [_item(itemId="i1", kind="assistant-message", title="", text="")]

    assert (
        render_activity(items, _turn()).blocks[0]["text"]["text"] == "_(nothing said)_"
    )


# ── The notification string ──────────────────────────────────────────────────


async def test_the_text_fallback_carries_the_doing_as_well_as_the_saying() -> None:
    """It is what a reader is left with when blocks do not render.

    A fallback holding only the conversation would drop the whole disclosure
    rather than shrink it, which is the one thing this file is here to prevent.
    """
    items = await _items()
    asked = next(item for item in items if item.kind == "user-message")
    text = render_activity_text(items, _turn())

    assert asked.text not in text
    assert "same fixture user" in text
    assert "✗ Ran tests/auth/test_login.py — 1 failed, 41 passed" in text


async def test_the_card_and_its_fallback_say_the_same_things() -> None:
    items = await _items()
    message = render_activity(items, _turn())

    assert message.text == render_activity_text(items, _turn())


# ── A turn drawn with its own request ─────────────────────────────────────────

REFERENCE = RequestReference(token="opaque-token", handle="R1")


async def _request() -> SnapshotRequest:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, source.session_id)
    return projection.open_requests()[0]


async def test_a_turn_with_a_request_is_one_message_not_two() -> None:
    items = await _items()
    turn = _turn()
    request = await _request()

    combined = render_turn_with_request(items, turn, request, REFERENCE)

    activity = render_activity(items, turn)
    card = render_request(request, REFERENCE)
    assert combined.blocks == activity.blocks + card.blocks
    assert combined.text == f"{activity.text}\n\n{card.text}"


async def test_the_recovery_marker_is_still_findable_in_the_combined_message() -> None:
    """`find_request_card` scans every block of a message for the marker, not
    only the first — `switch/adapter.py`'s own recovery search does — so the
    card's own marker, wherever it ends up, is enough on its own."""
    items = await _items()
    request = await _request()

    combined = render_turn_with_request(items, _turn(), request, REFERENCE)

    assert any(
        block.get("block_id") == f"switch-request:{REFERENCE.token}"
        for block in combined.blocks
    )
    # Exactly one: render_turn_with_request must not also stamp its own,
    # which would give the message two blocks sharing an id Slack expects
    # to be unique within it.
    markers = [
        block
        for block in combined.blocks
        if block.get("block_id") == f"switch-request:{REFERENCE.token}"
    ]
    assert len(markers) == 1


async def test_the_combined_text_stays_inside_what_slack_takes_for_one_string() -> None:
    """Each half already bounds itself to fit alone; nothing bounded the sum.

    Neither half on its own gets near Slack's cap, so this pushes both: a
    long turn near `render_activity_text`'s own ~39000-character ceiling,
    and a request with as many long options as an approval can carry. Only
    the two together clear 40000 — which is the join this is testing, not
    either renderer's own bound.
    """
    items = [
        _item(itemId=f"i{n}", kind="assistant-message", title="", text="x" * 2400)
        for n in range(20)
    ]
    request = await _request()
    content = request.content
    assert isinstance(content, ApprovalContent)
    big_request = request.model_copy(
        update={
            "content": content.model_copy(
                update={
                    "title": "t" * 1500,
                    "detail": "d" * 1200,
                    "options": [
                        ApprovalOption(
                            option_id=f"option-{n}", label="l" * 150, decision="accept"
                        )
                        for n in range(25)
                    ],
                }
            )
        }
    )

    combined = render_turn_with_request(items, _turn(), big_request, REFERENCE)

    assert len(combined.text) <= 40000
    assert render_request(big_request, REFERENCE).text in combined.text


async def test_a_combined_message_still_carries_the_request_s_buttons() -> None:
    items = await _items()
    request = await _request()

    combined = render_turn_with_request(items, _turn(), request, REFERENCE)

    actions = [b for b in combined.blocks if b["type"] == "actions"]
    assert actions, "the request's buttons must survive being embedded"
    assert actions[0]["elements"]


# ── The port: a request card that knows its own turn ──────────────────────────


def _slack_adapter() -> SlackAdapter:
    return SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="unused", app_token="unused", workspace_id="T123"
        )
    )


async def test_a_request_card_with_no_turn_draws_exactly_as_it_always_has() -> None:
    request = await _request()
    card = RequestCard(request, REFERENCE)

    rendered = _slack_adapter()._render_rich(card)

    assert rendered == render_request(request, REFERENCE)


async def test_a_request_card_with_its_turn_draws_the_combined_message() -> None:
    items = await _items()
    turn = _turn()
    request = await _request()
    card = RequestCard(request, REFERENCE, turn, items, elapsed_seconds=80)

    combined = _slack_adapter()._render_rich(card)

    assert combined == render_turn_with_request(
        items, turn, request, REFERENCE, elapsed_seconds=80
    )


async def test_a_turn_with_no_items_yet_still_draws_combined_not_dropped() -> None:
    """`turn` alone is the switch — leaving `items` unset must not silently
    fall back to the plain card. A turn that has emitted nothing yet is a
    real state (the moment a request opens before any tool call has run),
    and `items` defaults to empty rather than `None` so it stays
    representable rather than becoming a caller mistake that drops the turn
    with nothing logged.
    """
    turn = _turn()
    request = await _request()
    card = RequestCard(request, REFERENCE, turn)

    combined = _slack_adapter()._render_rich(card)

    assert combined == render_turn_with_request(
        [], turn, request, REFERENCE, elapsed_seconds=None
    )
    assert combined != render_request(request, REFERENCE)


async def test_a_turn_activity_card_is_unaffected_by_the_request_card_change() -> None:
    """Same dispatch function, two content types — confirms the new branch
    for `RequestCard` did not disturb the existing one for `TurnActivity`."""
    items = await _items()
    turn = _turn()

    rendered = _slack_adapter()._render_rich(TurnActivity(items, turn))

    assert rendered == render_activity(items, turn)
