"""An answer typed in words, as the bridge picks it up.

`test_session_text_grammar.py` covers what counts as an answer at all, and
`test_bridge_answers.py` under `session_activity` covers resolving one against
an approval card. This is the bridge's half: every message is offered to the
approval answers, a refusal is told back in the card's thread, and the room
still sees what was said either way.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.session.form import posted_form
from switch_core.bridges.collaboration.session.refusal import Refused
from switch_core.session_activity.bridge_answers import Answered, ApprovalAnswers

from .session_fixtures import open_request

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


# ── The record a card is answered against ──────────────────────────────────────────────


def test_the_positions_are_the_ones_the_card_actually_rendered() -> None:
    """The record is written from the same content the renderer numbers.

    If those two ever disagreed, "1" would answer a different question from the
    one the reader is looking at, and nothing would report it.
    """
    request = open_request()

    form = posted_form(request)

    assert form["kind"] == "approval"
    assert [option["optionId"] for option in form["options"]] == [
        option.option_id for option in request.content.options
    ]
    assert [option["decision"] for option in form["options"]] == [
        option.decision for option in request.content.options
    ]


# ── Where the bridge picks it up ─────────────────────────────────────────────


class _Notices:
    """An adapter that only records what it was asked to say to one person."""

    def __init__(self) -> None:
        self.told: list[tuple[str, str, str, str | None, str]] = []

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        self.told.append((channel_id, actor_ref, actor_name, thread_ref, text))


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _bridge(approval_answers: Any) -> tuple[Any, list[dict[str, str]]]:
    """A bridge core, and the list of messages that got past the answer path.

    The channel maps to a room and the puppet step records what it was asked
    for and then hands back nothing, which is where the relay stops. So a
    message in that list is one the answer path let through on its way to the
    room, and an empty list after a message is a message the room lost.

    Its adapter is a `_Notices`, so `bridge._adapter.told` is what the person
    who typed would have seen.
    """
    relayed: list[dict[str, str]] = []

    async def _is_registered_agent(name: str) -> bool:
        return False

    async def _repair_placeholder_username(*args: Any, **kwargs: Any) -> None:
        return None

    async def _ensure_user_in_matrix_room(**kwargs: str) -> None:
        relayed.append(kwargs)
        return None

    bridge = BridgeCore.__new__(BridgeCore)
    bridge._channel_to_room = {CHANNEL: ("room-uuid", "!room:test")}
    bridge._channel_locks = {}
    bridge._approval_answers = approval_answers
    bridge._adapter = _Notices()
    bridge._bridge_id = "bridge-1"
    # Instance attrs shadow the class methods so the DB is never touched.
    bridge._is_registered_agent = _is_registered_agent  # type: ignore[assignment]
    bridge._repair_placeholder_username = _repair_placeholder_username  # type: ignore[assignment]
    bridge._ensure_user_in_matrix_room = _ensure_user_in_matrix_room  # type: ignore[assignment]
    return bridge, relayed


class _NoDatabase:
    """A session factory for answers that must be settled before any query."""

    def __call__(self) -> Any:
        raise AssertionError("A message that is not an answer was looked up.")


async def _nobody(actor: Any) -> str | None:
    raise AssertionError("A message that is not an answer identified its sender.")


async def _never_first(channel_id: str, root_ref: str, ref: str) -> bool:
    raise AssertionError("A message that is not an answer read its thread.")


def _real_answers() -> ApprovalAnswers:
    return ApprovalAnswers(
        bridge_id="bridge-1",
        service=None,  # type: ignore[arg-type]
        session_factory=_NoDatabase(),  # type: ignore[arg-type]
        identify=_nobody,
        is_first_reply=_never_first,
    )


@pytest.mark.parametrize("said", ["①", "10²", "just shipped 2 fixes", "ok"])
def test_a_message_the_grammar_refuses_still_reaches_the_room(said: str) -> None:
    """The parse runs on everything said in a channel, so it must never raise.

    An exception here climbs out of `_handle_inbound_message`, the platform SDK
    logs it and moves on, and the message never reaches the room — with nothing
    in the channel to say why. So the proof is the relay carrying on, not the
    absence of a traceback. The answers are real ones over a database that
    fails if touched, so ordinary talk is also shown to cost no query.
    """
    bridge, relayed = _bridge(_real_answers())

    _run(bridge._handle_inbound_message(_typed(said)))

    assert bridge._adapter.told == []
    assert relayed == [
        {
            "external_user_id": "U1",
            "external_username": "someone",
            "room_id": "room-uuid",
            "matrix_room_id": "!room:test",
        }
    ]


def test_a_platform_that_draws_no_approval_cards_still_relays() -> None:
    bridge, relayed = _bridge(None)

    _run(bridge._handle_inbound_message(_typed("A1 yes")))

    assert bridge._adapter.told == []
    assert len(relayed) == 1


# ── Approval cards drawn from the host's reports ─────────────────────────────


class _ApprovalAnswers:
    def __init__(self, outcome: Answered | Refused | None) -> None:
        self.outcome = outcome
        self.asked: list[InboundMessage] = []

    async def for_text(self, message: InboundMessage) -> Answered | Refused | None:
        self.asked.append(message)
        return self.outcome


def test_an_answer_to_an_approval_card_is_recorded_and_still_relayed() -> None:
    approvals = _ApprovalAnswers(Answered(handle="A1"))
    bridge, relayed = _bridge(approvals)

    _run(bridge._handle_inbound_message(_typed("A1 yes")))

    assert [message.content for message in approvals.asked] == ["A1 yes"]
    assert bridge._adapter.told == []
    assert len(relayed) == 1


def test_a_refused_approval_answer_is_told_in_the_cards_thread() -> None:
    bridge, relayed = _bridge(
        _ApprovalAnswers(
            Refused(reason="the request is expired", handle="A1", card_ref="C1:999.0")
        )
    )

    _run(bridge._handle_inbound_message(_typed("A1 yes")))

    [(_, _, _, thread, text)] = bridge._adapter.told
    assert thread == "C1:999.0"
    assert text == "Your answer to A1 did not land, because the request is expired."
    assert len(relayed) == 1


def test_a_message_that_is_no_approval_answer_is_only_relayed() -> None:
    approvals = _ApprovalAnswers(None)
    bridge, relayed = _bridge(approvals)

    _run(bridge._handle_inbound_message(_typed("R42 1")))

    assert len(approvals.asked) == 1
    assert bridge._adapter.told == []
    assert len(relayed) == 1
