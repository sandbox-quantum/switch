"""What a turn's card says once its message has been edited."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

from switch_core.bridges.collaboration.session.renderers import (
    ITEM_EDITED_AFTER_START,
    ITEM_PROMPT_UPDATED,
    TURN_STATE,
    turn_state,
)
from switch_core.session_activity.bridge_turns import TurnView, status_state
from switch_core.sessions.contract import Item, TurnUpsert


def _user_item(title: str = "", revision: int = 1) -> Item:
    return Item(
        item_id="user-turn",
        turn_id="turn",
        revision=revision,
        kind="user-message",
        status="completed",
        title=title,
        text="words",
        attachments=[],
        origin=None,
    )


def _turn(status: str) -> TurnUpsert:
    return TurnUpsert(
        type="turn.upsert",
        turn_id="turn",
        status=status,  # type: ignore[arg-type]
        command_id="turn",
    )


def _state(status: str, title: str, **kwargs: Any) -> str:
    return turn_state(
        [_user_item(title)],
        _turn(status),
        tool_detail=True,
        **kwargs,
    )


def test_a_queued_edit_says_the_prompt_was_updated() -> None:
    state = _state("queued", ITEM_PROMPT_UPDATED)
    assert state.startswith("Queued (prompt updated).")


def test_an_edit_after_start_says_the_turn_is_unchanged() -> None:
    state = _state("running", ITEM_EDITED_AFTER_START)
    assert "Working" in state
    assert "Edited after start. Turn unchanged." in state


def test_it_still_says_so_once_the_turn_is_over() -> None:
    state = _state("completed", ITEM_EDITED_AFTER_START, elapsed_seconds=5)
    assert "Edited after start. Turn unchanged." in state


def test_an_update_that_made_it_in_is_not_mentioned_once_the_turn_runs() -> None:
    assert _state("running", ITEM_PROMPT_UPDATED) == TURN_STATE["running"]


def test_an_ignored_edit_changes_nothing_on_the_card() -> None:
    """An ignored edit leaves the item as it was, so the card reads as it did."""
    for status in ("queued", "running"):
        assert _state(status, "") == TURN_STATE[status]


def test_the_words_of_the_prompt_are_not_put_on_the_card() -> None:
    assert "words" not in _state("queued", ITEM_PROMPT_UPDATED)


def _view(title: str, status: str = "queued") -> TurnView:
    return TurnView(
        turn=_turn(status),
        items=[_user_item(title, revision=2 if title else 1)],
        row=cast("Any", SimpleNamespace(updated_at=datetime.now(UTC))),
        started_at=datetime.now(UTC),
    )


def _shown(view: TurnView) -> str:
    return status_state(
        view,
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )


def test_an_edit_redraws_the_card() -> None:
    assert _shown(_view(ITEM_PROMPT_UPDATED)) != _shown(_view(""))
    assert _shown(_view(ITEM_EDITED_AFTER_START, "running")) != _shown(
        _view("", "running")
    )


def test_a_card_nobody_edited_reads_as_it_always_did() -> None:
    assert _shown(_view("")) == "queued::/"
