"""An answer typed in words, as a command the session can be given.

`test_session_answers.py` is the same journey for a pressed button, and shares
its helpers with this file. The claim under all of it: typing the answer and
pressing it produce the same command, and everything the press refuses the
typed form refuses too.

`test_session_text_grammar.py` covers what counts as an answer at all. This is
what happens once something does.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.session.outbound import posted_options
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)

from .test_session_answers import EXAMPLES_PATH, _interactions, _post, _press, _run

CHANNEL = "C1"
CARD = "C1:111.0"


def _typed(text: str, **overrides: Any) -> InboundMessage:
    fields: dict[str, Any] = {
        "channel_id": CHANNEL,
        "channel_type": "channel_public",
        "sender_id": "U1",
        "sender_name": "someone",
        "content": text,
        "message_ref": "C1:222.0",
        "root_id": None,
    }
    fields.update(overrides)
    return InboundMessage(**fields)


# ── The same answer, either way ──────────────────────────────────────────────


def test_typing_the_answer_and_pressing_it_build_the_same_command() -> None:
    """Same option, same actor, same revision — so the same command, id and all.

    The derived id is what makes this true: one person answering the same
    question the same way is one decision however they said it.
    """
    interactions = _interactions(_post())

    pressed = _run(interactions.command_for(_press()))
    typed = _run(interactions.command_for_text(_typed("R42 1")))

    assert pressed is not None and typed is not None
    assert typed.command_id == pressed.command_id
    assert typed.model_dump(by_alias=True) | {
        "origin": pressed.origin.model_dump(by_alias=True)
    } == pressed.model_dump(by_alias=True)


def test_the_message_that_answered_is_what_the_origin_points_at() -> None:
    """Not the card. The origin says where the answer came from, not the question."""
    interactions = _interactions(_post())

    command = _run(interactions.command_for_text(_typed("R42 1")))

    assert command is not None
    assert command.origin.message_id == "C1:222.0"
    assert command.origin.thread_id == "thread-demo"


def test_a_number_picks_the_option_at_that_position_on_the_card() -> None:
    interactions = _interactions(_post())

    command = _run(interactions.command_for_text(_typed("R42 2")))

    assert command is not None
    assert command.body.answer.option_id == "deny"


def test_the_positions_are_the_ones_the_card_actually_rendered() -> None:
    """The record is written from the same content the renderer numbers.

    If those two ever disagreed, "1" would answer a different question from the
    one the reader is looking at, and nothing would report it.
    """
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    request = _run(project(source, "session-demo")).open_room_requests("room-demo")[0]

    options = posted_options(request)

    assert [option["optionId"] for option in options] == [
        option.option_id for option in request.content.options
    ]
    assert [option["decision"] for option in options] == [
        option.decision for option in request.content.options
    ]


# ── The bare form ────────────────────────────────────────────────────────────


def test_a_bare_yes_answers_the_card_it_is_a_reply_to() -> None:
    interactions = _interactions(_post())

    command = _run(interactions.command_for_text(_typed("yes", root_id=CARD)))

    assert command is not None
    assert command.body.answer.option_id == "allow-once"


def test_a_bare_yes_anywhere_else_answers_nothing() -> None:
    """Agreeing with someone in a channel is not answering a permission prompt."""
    interactions = _interactions(_post())

    assert _run(interactions.command_for_text(_typed("yes"))) is None
    assert (
        _run(interactions.command_for_text(_typed("yes", root_id="C1:999.0"))) is None
    )


def test_a_bare_yes_will_not_grant_a_permission_for_the_whole_session() -> None:
    """Allow-once and allow-for-the-session must not be one word apart."""
    interactions = _interactions(
        _post(
            options=[
                {"optionId": "always", "decision": "acceptForSession"},
                {"optionId": "deny", "decision": "decline"},
            ]
        )
    )

    assert _run(interactions.command_for_text(_typed("yes", root_id=CARD))) is None


def test_a_word_that_fits_two_options_fits_neither() -> None:
    """Two ways to say yes and no way to tell which was meant. Refuse and say so."""
    interactions = _interactions(
        _post(
            options=[
                {"optionId": "allow-once", "decision": "accept"},
                {"optionId": "allow-and-remember", "decision": "accept"},
            ]
        )
    )

    assert _run(interactions.command_for_text(_typed("yes", root_id=CARD))) is None


def test_a_bare_no_still_finds_the_one_way_to_decline() -> None:
    interactions = _interactions(_post())

    command = _run(interactions.command_for_text(_typed("no", root_id=CARD)))

    assert command is not None
    assert command.body.answer.option_id == "deny"


# ── What it refuses ──────────────────────────────────────────────────────────


def test_a_number_the_card_has_no_option_at_answers_nothing() -> None:
    interactions = _interactions(_post())

    assert _run(interactions.command_for_text(_typed("R42 9"))) is None


def test_a_handle_from_another_channel_names_no_request_here() -> None:
    """A handle is only unambiguous as far as a person can see, so no further."""
    interactions = _interactions(_post(external_channel_id="C2"))

    assert _run(interactions.command_for_text(_typed("R42 1"))) is None


def test_a_handle_minted_by_another_bridge_names_no_request_here() -> None:
    interactions = _interactions(_post(bridge_id="bridge-2"))

    assert _run(interactions.command_for_text(_typed("R42 1"))) is None


def test_an_actor_with_no_switch_identity_answers_nothing() -> None:
    """Same refusal as a press: an answer carries who gave it, or it is not sent."""
    interactions = _interactions(_post(), actor=None)

    assert _run(interactions.command_for_text(_typed("R42 1"))) is None


def test_an_app_cannot_answer_a_request() -> None:
    """A Slack workflow posting "yes" in a card's thread decides nothing.

    A press cannot come from an app, and neither can a decision: an answer is
    attributed to whoever made it, and an app made none.
    """
    interactions = _interactions(_post())

    assert (
        _run(interactions.command_for_text(_typed("R42 1", sender_is_app=True))) is None
    )


def test_ordinary_talk_never_reaches_the_store() -> None:
    """The grammar runs before the query, so a channel pays nothing for this."""

    class _Explodes:
        async def get_by_handle(self, *args: object) -> None:
            raise AssertionError("A message that is not an answer was looked up.")

        async def get_by_post(self, *args: object) -> None:
            raise AssertionError("A message that is not an answer was looked up.")

    interactions = _interactions(_post())
    interactions._posts = _Explodes()  # type: ignore[assignment]

    assert _run(interactions.command_for_text(_typed("R42 is the one I meant"))) is None
    assert _run(interactions.command_for_text(_typed("sounds good to me"))) is None


# ── Where the bridge picks it up ─────────────────────────────────────────────


def _bridge(interactions: Any) -> Any:
    """A bridge core with just enough of itself to take one inbound message."""

    async def _is_registered_agent(name: str) -> bool:
        return False

    async def _create_room_for_channel(**kwargs: Any) -> None:
        return None

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._channel_to_room = {}
    bridge._channel_locks = {}
    bridge._session_interactions = interactions
    # Instance attrs shadow the class methods so the DB is never touched.
    bridge._is_registered_agent = _is_registered_agent  # type: ignore[assignment]
    bridge._create_room_for_channel = _create_room_for_channel  # type: ignore[assignment]
    return bridge


def test_a_message_in_a_channel_is_offered_to_the_session(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The relay path is where a typed answer is noticed, and it says so.

    There is no route into a session yet, so the command is built and dropped —
    but dropped out loud, because an answer that vanishes is the one outcome
    nobody could debug.
    """
    interactions = _interactions(_post())
    with caplog.at_level(logging.WARNING):
        _run(_bridge(interactions)._handle_inbound_message(_typed("R42 1")))

    assert "dropped it" in caplog.text
    assert "session-demo" in caplog.text


def test_a_platform_that_has_never_posted_a_card_finds_nothing_to_answer(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every bridge type is a contract surface, so every one runs this path.

    Mattermost, Discord, Teams and Telegram post no request cards yet, but they
    do parse. What stops them is that the handle resolves to no row of theirs,
    not that they skip the attempt.
    """
    interactions = _interactions(surface="mattermost")
    with caplog.at_level(logging.WARNING):
        _run(_bridge(interactions)._handle_inbound_message(_typed("R42 1")))

    assert caplog.text == ""


def test_a_message_the_grammar_refuses_does_not_take_the_relay_with_it() -> None:
    """The parse runs on everything said in a channel, so it must never raise.

    An exception here climbs out of `_handle_inbound_message`, the platform SDK
    logs it and moves on, and the message never reaches the room — with nothing
    in the channel to say why.
    """
    interactions = _interactions(_post())

    for said in ["①", "10²", "just shipped 2 fixes", "ok"]:
        _run(_bridge(interactions)._handle_inbound_message(_typed(said)))
