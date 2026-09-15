"""A control someone operated, as a command the session can be given.

The outbound half of this is `test_session_slack_requests.py`. This is what
comes back: what the bridge is willing to build from a callback, what it
refuses, and where each field of the result actually came from — because the
whole point is that almost none of it comes from the payload.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.inbound import (
    InboundActor,
    Refused,
    SessionInteractions,
)
from switch_core.bridges.collaboration.session.renderers import (
    ANSWER_ACTION,
    POSITION_ACTION,
    position_action,
)
from switch_core.db.models import SessionRequestPost

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

BRIDGE = "bridge-1"
TOKEN = "opaque-token"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _NoSession:
    """The store here never touches its session, so nor does this."""

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *args: object) -> bool:
        return False

    def __call__(self) -> _NoSession:
        return self


class _Posts:
    """The rows a bridge has, keyed the way the store keys them."""

    def __init__(self, *rows: SessionRequestPost) -> None:
        self._rows = rows

    async def get_by_token(
        self, session: object, bridge_id: str, token: str
    ) -> SessionRequestPost | None:
        return self._one(lambda row: row.bridge_id == bridge_id and row.token == token)

    async def get_by_handle(
        self, session: object, bridge_id: str, channel_id: str, handle: str
    ) -> SessionRequestPost | None:
        return self._one(
            lambda row: (
                row.bridge_id == bridge_id
                and row.external_channel_id == channel_id
                and row.handle.lower() == handle.lower()
            )
        )

    async def get_by_post(
        self, session: object, bridge_id: str, external_post_id: str
    ) -> SessionRequestPost | None:
        return self._one(
            lambda row: (
                row.bridge_id == bridge_id and row.external_post_id == external_post_id
            )
        )

    def _one(
        self, matches: Callable[[SessionRequestPost], bool]
    ) -> SessionRequestPost | None:
        return next((row for row in self._rows if matches(row)), None)


def _approval_form(*options: tuple[str, str]) -> dict[str, Any]:
    """An approval's record: which options, in the order the card drew them."""
    return {
        "kind": "approval",
        "options": [
            {"optionId": option_id, "decision": decision}
            for option_id, decision in options
        ],
    }


def _questions_form(*questions: tuple[str, list[str], bool, bool]) -> dict[str, Any]:
    """A form's record: per question, its options and what it will accept."""
    return {
        "kind": "questions",
        "questions": [
            {
                "questionId": question_id,
                "optionIds": option_ids,
                "multiSelect": multi_select,
                "allowCustomAnswer": allow_custom,
            }
            for question_id, option_ids, multi_select, allow_custom in questions
        ],
    }


def _post(**overrides: Any) -> SessionRequestPost:
    fields: dict[str, Any] = {
        "bridge_id": BRIDGE,
        "token": TOKEN,
        "handle": "R42",
        "external_channel_id": "C1",
        "external_post_id": "C1:111.0",
        "room_id": "room-demo",
        "thread_id": "thread-demo",
        "session_id": "session-demo",
        "epoch": "epoch-demo",
        "request_id": "request-demo",
        "revision": 1,
        "form": _approval_form(("allow-once", "accept"), ("deny", "decline")),
    }
    fields.update(overrides)
    return SessionRequestPost(**fields)


def _interactions(
    *rows: SessionRequestPost,
    actor: str | None = "@someone:test",
    surface: Any = "slack",
    first_reply: bool = True,
) -> SessionInteractions:
    async def identify(actor_of: InboundActor) -> str | None:
        return actor

    async def is_first_reply(channel_id: str, root_ref: str, ref: str) -> bool:
        return first_reply

    return SessionInteractions(
        bridge_id=BRIDGE,
        surface=surface,
        posts=_Posts(*rows),  # type: ignore[arg-type]
        session_factory=_NoSession(),  # type: ignore[arg-type]
        identify=identify,
        is_first_reply=is_first_reply,
    )


def _press(**overrides: Any) -> InboundInteraction:
    fields: dict[str, Any] = {
        "channel_id": "C1",
        "sender_id": "U1",
        "sender_name": "someone",
        "action_id": f"{ANSWER_ACTION}:allow-once",
        "value": TOKEN,
        "message_ref": "C1:111.0",
    }
    fields.update(overrides)
    return InboundInteraction(**fields)


# ── What it builds ───────────────────────────────────────────────────────────


def test_a_press_becomes_the_answer_the_contract_documents() -> None:
    """Field for field, the shape `examples.json` records for a platform answer.

    Only the command id differs, and deliberately: the example's is arbitrary
    and this one is derived from what was decided.
    """
    recorded = json.loads(EXAMPLES_PATH.read_text())["platformAnswer"]
    interactions = _interactions(_post(), actor="actor-demo", surface="mattermost")

    command = _run(interactions.command_for(_press()))

    assert command is not None
    built = command.model_dump(by_alias=True)
    recorded["origin"]["messageId"] = "C1:111.0"
    assert built | {"commandId": recorded["commandId"]} == recorded


def test_the_revision_answered_against_comes_off_the_record() -> None:
    """Not off the callback, which never carried one and could not be believed."""
    interactions = _interactions(_post(revision=7))

    command = _run(interactions.command_for(_press()))

    assert command is not None
    assert command.body.expected_revision == 7  # type: ignore[union-attr]


def test_the_actor_is_the_identity_the_bridge_verified() -> None:
    """The payload names a Slack account; the command names a Switch one."""
    interactions = _interactions(_post(), actor="@verified:test")

    command = _run(interactions.command_for(_press(sender_id="U-imposter")))

    assert command is not None
    assert command.origin.actor_id == "@verified:test"
    assert "U-imposter" not in command.model_dump_json()


def test_pressing_twice_is_one_command() -> None:
    interactions = _interactions(_post())

    first = _run(interactions.command_for(_press()))
    second = _run(interactions.command_for(_press()))

    assert first is not None and second is not None
    assert first.command_id == second.command_id


def test_two_people_choosing_differently_stay_two_commands() -> None:
    allowed = _run(_interactions(_post(), actor="@a:test").command_for(_press()))
    denied = _run(
        _interactions(_post(), actor="@b:test").command_for(
            _press(action_id=f"{ANSWER_ACTION}:deny")
        )
    )

    assert allowed is not None and denied is not None
    assert allowed.command_id != denied.command_id


# ── What it refuses ──────────────────────────────────────────────────────────


def test_a_control_this_layer_did_not_write_is_not_ours() -> None:
    interactions = _interactions(_post())

    assert _run(interactions.command_for(_press(action_id="other-app:go"))) is None


def test_a_token_naming_no_request_answers_nothing() -> None:
    """A card that outlived its record, or a payload that was never ours."""
    interactions = _interactions(_post())

    assert isinstance(_run(interactions.command_for(_press(value="made-up"))), Refused)


def test_a_token_from_another_bridge_answers_nothing() -> None:
    """The row is there; it belongs to a different workspace's connection."""
    interactions = _interactions(_post(bridge_id="bridge-2"))

    assert isinstance(_run(interactions.command_for(_press())), Refused)


def test_an_actor_with_no_switch_identity_answers_nothing() -> None:
    """An answer records who gave it. There is no default actor."""
    interactions = _interactions(_post(), actor=None)

    assert isinstance(_run(interactions.command_for(_press())), Refused)


def test_callback_cannot_reuse_a_token_on_another_message_or_channel() -> None:
    interactions = _interactions(_post())
    assert _run(interactions.command_for(_press(channel_id="another-channel"))) is None
    assert _run(interactions.command_for(_press(message_ref="C1:222.0"))) is None
    assert _run(interactions.command_for(_press(message_ref=None))) is None


# ── The same press, from a platform with no room for an option id ────────────


def test_a_press_by_position_answers_the_option_the_card_drew_there() -> None:
    """Telegram's press: the second control on the card, and nothing else."""
    interactions = _interactions(_post())

    command = _run(interactions.command_for(_press(action_id=position_action(2))))

    assert command is not None
    assert command.body.answer.option_id == "deny"  # type: ignore[union-attr]


def test_a_position_and_the_option_id_it_stands_for_are_one_command() -> None:
    """Two platforms, two payload shapes, one decision — so one command id.

    What is being checked is that the position resolves to the option rather
    than travelling on into the command as a number of its own.
    """
    by_position = _run(
        _interactions(_post()).command_for(_press(action_id=position_action(1)))
    )
    by_id = _run(
        _interactions(_post()).command_for(
            _press(action_id=f"{ANSWER_ACTION}:allow-once")
        )
    )

    assert by_position is not None and by_id is not None
    assert by_position.command_id == by_id.command_id


def test_the_record_says_which_option_a_position_is() -> None:
    """The card's order, not the request's now: the record is what was drawn."""
    reordered = _post(
        form=_approval_form(("deny", "decline"), ("allow-once", "accept"))
    )

    command = _run(
        _interactions(reordered).command_for(_press(action_id=position_action(1)))
    )

    assert command is not None
    assert command.body.answer.option_id == "deny"  # type: ignore[union-attr]


def test_a_press_past_the_end_of_the_card_is_refused() -> None:
    """A number no control was drawn at. The record is the only thing that
    could say so, and it says so before anything is decided."""
    interactions = _interactions(_post())

    refused = _run(interactions.command_for(_press(action_id=position_action(9))))

    assert isinstance(refused, Refused)
    assert "2 options, not 9" in refused.reason


def test_a_position_that_is_not_a_count_names_no_control() -> None:
    """Nothing this layer wrote looks like these, so none of them is ours.

    `int` would take the Arabic-Indic digits, and a form resolved against a
    number nobody can type is a press that cannot be reproduced by hand.
    """
    interactions = _interactions(_post())

    for action_id in (
        f"{POSITION_ACTION}:0",
        f"{POSITION_ACTION}:-1",
        f"{POSITION_ACTION}:1.0",
        f"{POSITION_ACTION}:",
        f"{POSITION_ACTION}:٢",
        f"{POSITION_ACTION}x:1",
    ):
        assert _run(interactions.command_for(_press(action_id=action_id))) is None


def test_a_press_by_position_answers_a_single_question() -> None:
    post = _post(form=_questions_form(("q1", ["red", "blue"], False, False)))

    command = _run(
        _interactions(post).command_for(_press(action_id=position_action(2)))
    )

    assert command is not None
    assert command.body.answer.answers[0].selected_option_ids == ["blue"]  # type: ignore[union-attr]


def test_a_press_by_position_refuses_the_forms_a_press_cannot_answer() -> None:
    """The same two refusals a press by id gets, reached the same way: one
    press is one option, and it has to belong to one question."""
    two_questions = _post(
        form=_questions_form(
            ("q1", ["red"], False, False), ("q2", ["blue"], False, False)
        )
    )
    many_at_once = _post(form=_questions_form(("q1", ["red", "blue"], True, False)))

    for post in (two_questions, many_at_once):
        refused = _run(
            _interactions(post).command_for(_press(action_id=position_action(1)))
        )
        assert isinstance(refused, Refused)
