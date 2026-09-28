"""A Teams turn's tool calls, folded away under the status that summarises them.

Teams is the platform with no private reply channel outside a universal action
and no message a bot can post that only one reader sees. So the log is not
fetched on demand the way Discord's is — it travels in the card, hidden, and
`Action.ToggleVisibility` unhides it in the reader's own client. Nothing about
that press reaches Switch, which is the point: one reader opening the log
changes nothing for anyone else reading the same message.

The two things that fall out of drawing it that way, and are tested here:

- the fold is offered on an *ended* turn only. A running turn's card is
  rewritten on every tool call, and a rewritten card arrives folded shut.
- the card asks for no newer schema than a plain message does, because hiding
  and showing elements is two releases older than the base version. A fold
  costs no client the card.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import TurnActivity

from .session_fixtures import _item, _turn
from .test_teams_adapter import _card_text, _run
from .test_teams_sdk_only import (
    AGENT,
    CHANNEL,
    ROOT,
    _activity,
    _card,
    _Connector,
    _teams,
)

SHOW_ID = "switchActivityShow"
HIDE_ID = "switchActivityHide"
DETAIL_ID = "switchActivityDetail"


def _ended(*titles: str) -> TurnActivity:
    """A finished turn that made the named calls, in the order named."""
    items = [
        _item(itemId=f"item-{position}", title=title)
        for position, title in enumerate(titles, start=1)
    ]
    return TurnActivity(items, _turn("completed"))


def _posted(connector: _Connector) -> dict[str, Any]:
    return dict(connector.sends[0]["activity"]["attachments"][0]["content"])


def _elements(card: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The fold's three elements, by id, or as many of them as are there."""
    return {
        str(block["id"]): block for block in card["body"] if block.get("id") is not None
    }


def _log_lines(card: dict[str, Any]) -> list[str]:
    """What the hidden container shows once a reader opens it."""
    detail = _elements(card)[DETAIL_ID]
    return [
        line
        for block in detail["items"]
        for line in str(block["text"]).split("\n")
        if line
    ]


def _fold(connector: _Connector) -> dict[str, dict[str, Any]]:
    return _elements(_posted(connector))


# ── When the fold is offered ─────────────────────────────────────────────────


def test_an_ended_turn_carries_its_tool_calls_folded_under_the_status() -> None:
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("Read a file", "Ran a test"), ROOT))

    assert _log_lines(_posted(connector)) == ["⌗ ✓ Read a file", "⌗ ✓ Ran a test"]


def test_a_running_turn_is_offered_no_fold_because_the_next_call_would_shut_it() -> (
    None
):
    """Every change rewrites the card and a rewritten card arrives collapsed. A
    fold that snapped shut under a reader mid-read would be worse than the
    status line they already have."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    assert _fold(connector) == {}


def test_a_turn_with_nothing_behind_it_is_offered_nothing_to_open() -> None:
    """The fold promises something is behind it. "No activity." under a status
    line already saying so is not what anybody pressed for.

    An item a host has opened and not yet filled is nothing behind it: the
    agent has not said anything yet, it has been given somewhere to say it.
    """
    adapter, connector = _teams()

    _run(
        adapter.post_rich(
            CHANNEL,
            AGENT,
            TurnActivity([_item(kind="assistant-message")], _turn("completed")),
            ROOT,
        )
    )

    assert _fold(connector) == {}


def test_the_fold_arrives_on_the_redraw_that_ends_the_turn() -> None:
    """The status is posted while the turn runs and rewritten when it stops, so
    the edit is where the log has to appear — nothing posts the card again."""
    adapter, connector = _teams()
    ref = _run(adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT))

    _run(adapter.update_rich(CHANNEL, AGENT, ref, _ended("Ran a test"), ROOT))

    edited = connector.updates[0]["activity"]["attachments"][0]["content"]
    assert _log_lines(edited) == ["⌗ ✓ Ran a test"]


def test_what_the_agent_said_is_in_the_fold_and_not_on_the_card() -> None:
    """The prose an agent produces beside its work never reached a Teams
    channel at all. It arrives folded rather than in the status, because the
    reply is what the channel gets unprompted and much of the rest is the agent
    narrating itself."""
    adapter, connector = _teams()
    items = [
        _item(itemId="item-1", title="Ran the tests"),
        _item(itemId="item-2", kind="assistant-message", title="", text="All green."),
    ]

    _run(
        adapter.post_rich(CHANNEL, AGENT, TurnActivity(items, _turn("completed")), ROOT)
    )

    card = _posted(connector)
    assert _log_lines(card) == ["\u2317 \u2713 Ran the tests", "\u275d All green."]
    assert "All green." not in card["fallbackText"]


def test_a_turn_that_only_talked_is_still_worth_a_fold() -> None:
    """It used to be offered nothing, because it called nothing. Now the thing
    it produced is the thing behind the fold."""
    adapter, connector = _teams()
    said = _item(kind="assistant-message", title="", text="Fixed yesterday.")

    _run(
        adapter.post_rich(
            CHANNEL, AGENT, TurnActivity([said], _turn("completed")), ROOT
        )
    )

    assert _log_lines(_posted(connector)) == ["\u275d Fixed yesterday."]


# ── What opening it does ─────────────────────────────────────────────────────


def test_the_log_starts_hidden_and_so_does_the_button_that_closes_it() -> None:
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("Ran a test"), ROOT))

    fold = _fold(connector)
    assert fold[DETAIL_ID]["isVisible"] is False
    assert fold[HIDE_ID]["isVisible"] is False
    assert "isVisible" not in fold[SHOW_ID]


def test_opening_and_closing_are_exact_opposites_of_each_other() -> None:
    """An Adaptive Card action's title is fixed, so "show" and "hide" have to
    be two buttons that swap places. A reader sees exactly one of them, and it
    says what pressing it will do."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("Ran a test"), ROOT))

    fold = _fold(connector)
    show = fold[SHOW_ID]["actions"][0]
    hide = fold[HIDE_ID]["actions"][0]
    assert show["title"] == "Show activity"
    assert hide["title"] == "Hide activity"
    assert show["targetElements"] == [
        {"elementId": SHOW_ID, "isVisible": False},
        {"elementId": DETAIL_ID, "isVisible": True},
        {"elementId": HIDE_ID, "isVisible": True},
    ]
    assert hide["targetElements"] == [
        {"elementId": SHOW_ID, "isVisible": True},
        {"elementId": DETAIL_ID, "isVisible": False},
        {"elementId": HIDE_ID, "isVisible": False},
    ]


def test_a_press_on_the_fold_reaches_switch_in_no_way_at_all() -> None:
    """`ToggleVisibility` is drawn by the client and carries no verb and no
    data. That is what makes opening the log local to one reader, and it is
    also why an adapter with no interaction handler can still offer it."""
    adapter, connector = _teams()
    assert adapter._on_interaction is None

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("Ran a test"), ROOT))

    for element in _fold(connector).values():
        for action in element.get("actions", []):
            assert action["type"] == "Action.ToggleVisibility"
            assert "verb" not in action
            assert "data" not in action


# ── What it costs the card ───────────────────────────────────────────────────


def test_a_folded_card_asks_for_no_newer_schema_than_a_plain_message() -> None:
    """A client too old for the version a card names drops the whole card and
    shows `fallbackText`. Hiding elements predates the base version, so the
    fold is free — unlike `Action.Execute`, which is not."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("Ran a test"), ROOT))

    assert _posted(connector)["version"] == "1.4"


def test_a_request_card_still_asks_for_the_schema_its_buttons_need() -> None:
    adapter, connector = _teams()

    async def _ignore(interaction: Any) -> None:
        return None

    adapter.set_interaction_handler(_ignore)

    _run(adapter.post_rich(CHANNEL, AGENT, _run(_card()), ROOT))

    assert _posted(connector)["version"] == "1.5"


def test_a_request_card_is_offered_options_rather_than_a_fold() -> None:
    """One card asks one thing. A collapsed log under the options competes for
    the press the card exists to collect."""
    adapter, connector = _teams()

    async def _ignore(interaction: Any) -> None:
        return None

    adapter.set_interaction_handler(_ignore)

    _run(adapter.post_rich(CHANNEL, AGENT, _run(_card()), ROOT))

    assert DETAIL_ID not in _elements(_posted(connector))


def test_the_folded_log_stays_out_of_the_notification_and_the_fallback() -> None:
    """`summary` is the toast and `fallbackText` is what a client that cannot
    draw the card shows. Both are the status: a log a reader has not opened is
    not something to push at them, or to unfold on their behalf."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("Read a secret file"), ROOT))

    activity = connector.sends[0]["activity"]
    assert "Read a secret file" not in activity["summary"]
    assert "Read a secret file" not in _posted(connector)["fallbackText"]
    assert "Read a secret file" not in _card_text(activity)


def test_the_log_does_not_repeat_the_state_line_it_is_folded_under() -> None:
    """The status sits immediately above and carries the turn's state and its
    Console link. Printing both again as the log's first line is the card
    showing the same sentence twice, a centimetre apart."""
    adapter, connector = _teams()

    _run(
        adapter.post_rich(
            CHANNEL,
            AGENT,
            TurnActivity(
                [_item(title="Ran a test")],
                _turn("completed"),
                session_url="https://console.example.test/s/1",
            ),
            ROOT,
        )
    )

    card = _posted(connector)
    assert "console.example.test" in _card_text(connector.sends[0]["activity"])
    assert _log_lines(card) == ["⌗ ✓ Ran a test"]


def test_host_text_in_the_log_goes_through_the_platforms_own_escape() -> None:
    """Every title in there came from a host, and a TextBlock renders markdown
    — including a `<at>` tag that `_mention_entities` would then pair with a
    real person."""
    adapter, connector = _teams()

    _run(adapter.post_rich(CHANNEL, AGENT, _ended("<at>alice</at>"), ROOT))

    assert "<at>alice</at>" not in "\n".join(_log_lines(_posted(connector)))


def test_a_log_too_long_for_the_card_is_cut_and_says_how_much_it_cut() -> None:
    """A turn with hundreds of calls must not grow the card without bound, and
    a log that quietly showed its tail reads as a turn that made only those
    calls."""
    adapter, connector = _teams()

    _run(
        adapter.post_rich(
            CHANNEL, AGENT, _ended(*[f"Call {n}" for n in range(400)]), ROOT
        )
    )

    lines = _log_lines(_posted(connector))
    assert lines[0].startswith("…")
    assert "not shown" in lines[0]
    assert len("\n".join(lines)) <= 2000
    assert lines[-1] == "⌗ ✓ Call 399"
