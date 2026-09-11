"""A turn's neutral fallback: what a platform with no card of its own shows.

`test_session_activity.py` covers Slack's own card and its notification
string. This is the other one — written new rather than lifted off Slack's, so
it carries only what a reader came for on a platform with nothing behind it at
all: the last thing the agent said, and whether the turn is still going.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.session.renderers.neutral import turn_summary
from switch_core.sessions.contract import Item, TurnUpsert

from .test_session_activity import TURN, _item, _items, _turn


def _identity(text: str) -> str:
    return text


async def test_the_summary_is_the_last_thing_said_and_the_turn_state() -> None:
    items = await _items()

    summary = turn_summary(items, _turn("completed"), escape=_identity, limit=10_000)

    assert summary.splitlines() == [
        "It fails whenever it runs after the session test: both write to the "
        "same fixture user, and only the second one has to notice. Pinning "
        "the fixture to one user per test fixes it.",
        "Turn complete. 1 step left unfinished.",
    ]


def _tool_call(**fields: object) -> Item:
    return _item(kind="tool-activity", **fields)


def test_a_turn_with_only_tool_calls_so_far_is_just_its_state() -> None:
    """Nothing said yet, so the state line is the whole of it."""
    items = [_tool_call()]

    summary = turn_summary(items, _turn("running"), escape=_identity, limit=10_000)

    assert summary == "Working…"


def test_the_placeholder_for_an_empty_message_is_bound_by_the_budget_too() -> None:
    """An assistant item can have empty text; the placeholder still has to fit."""
    items = [_item(kind="assistant-message", title="", text="")]
    state = "Turn complete."

    summary = turn_summary(
        items, _turn("completed"), escape=_identity, limit=len(state) + 1 + 5
    )

    assert len(summary) <= len(state) + 1 + 5
    assert summary.splitlines()[0] == "(not…"


def test_what_was_said_goes_through_the_platforms_escape() -> None:
    """The last thing said is host text, same as everywhere else it is shown."""
    items = [_item(kind="assistant-message", title="", text="<script>")]

    def _shout(text: str) -> str:
        return text.upper()

    summary = turn_summary(items, _turn("running"), escape=_shout, limit=10_000)

    assert summary.splitlines()[0] == "<SCRIPT>"


def test_the_state_line_survives_a_budget_too_tight_for_what_was_said() -> None:
    """What gets cut under a tight budget is what was said, not whether it ran."""
    items = [
        _item(kind="assistant-message", title="", text="a rather long thing to say")
    ]
    state = "Turn complete."

    summary = turn_summary(
        items, _turn("completed"), escape=_identity, limit=len(state) + 5
    )

    assert summary.endswith(f"\n{state}")
    assert len(summary.splitlines()[0]) < len("a rather long thing to say")


def test_a_budget_too_tight_even_for_the_state_still_returns_something() -> None:
    items = [_item(kind="assistant-message", title="", text="anything")]

    summary = turn_summary(items, _turn("completed"), escape=_identity, limit=3)

    assert summary
    assert len(summary) <= 3


def test_a_persons_own_message_is_never_shown_as_the_agents() -> None:
    """The prompt that started the turn arrives before the agent has said a word.

    There is no card here to attribute it against the way Slack's does, so
    showing it bare on its own line would read as the agent's words.
    """
    items = [_item(kind="user-message", title="", text="please do the thing")]

    summary = turn_summary(items, _turn("running"), escape=_identity, limit=10_000)

    assert summary == "Working…"


def test_a_mid_turn_interjection_does_not_displace_what_the_agent_said() -> None:
    """Someone types "actually, stop" after the agent has already said something."""
    items = [
        _item(itemId="i1", kind="assistant-message", title="", text="Looking now."),
        _item(itemId="i2", kind="user-message", title="", text="actually, stop"),
    ]

    summary = turn_summary(items, _turn("running"), escape=_identity, limit=10_000)

    assert summary.splitlines()[0] == "Looking now."


def test_an_escape_that_expands_the_text_still_lands_inside_the_budget() -> None:
    """The escaped form must fit `limit`, not just the raw text before it.

    A naive cut on the raw text and an escape afterwards can overshoot: five
    characters cut to two and then each expanded to four is longer than the
    budget that produced the cut. The result has to be found on the source
    escaped whole, the way `slack.py`'s own `_fit` does it.
    """
    items = [_item(kind="assistant-message", title="", text="<" * 5)]
    state = "Turn complete."

    def _entity_escape(text: str) -> str:
        return text.replace("<", "&lt;")

    limit = len(state) + 1 + 5  # 5 characters of budget for what was said
    summary = turn_summary(
        items, _turn("completed"), escape=_entity_escape, limit=limit
    )

    assert len(summary) <= limit
    said = summary.splitlines()[0]
    assert said == "&lt;…"
    assert "&lt" not in said.replace("&lt;", "")


def test_nothing_said_and_no_tool_calls_is_still_just_the_state() -> None:
    """A brand new turn: nothing folded in yet at all."""
    turn = TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": TURN, "status": "queued", "commandId": None}
    )

    assert (
        turn_summary([], turn, escape=_identity, limit=10_000)
        == "Received. Waiting for the agent…"
    )
