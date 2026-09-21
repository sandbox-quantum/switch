"""Answering a Teams permission card by pressing it.

The buttons are `Action.Execute`, which is the only card action that reaches
the bot with a reply the presser alone is shown — an `Action.Submit` posts a
message into the conversation, so a refusal would be read by everybody who was
not answering. That is the whole reason the card asks for schema 1.5.

What travels in a button is the card's opaque token and the number beside the
option, and nothing else: not who may press it, not the option's own id. Who
pressed comes from the activity, and both halves are resolved against the
stored record rather than trusted.

The body still lists every option in full, unlike Telegram's. A client too old
for the universal action model drops the buttons, and a card whose options only
lived on them would drop the question too.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

import pytest

from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.form import (
    posted_form,
    resolve_pressed_position,
)
from switch_core.bridges.collaboration.session.renderers import parse_answer_position
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    _publication_ref,
)
from switch_core.bridges.collaboration.teams.cards import ANSWER_VERB

from .test_teams_adapter import _card_text, _FakeHttpRequest
from .test_teams_sdk_only import (
    AGENT,
    CHANNEL,
    ROOT,
    SERVICE_URL,
    _activity,
    _card,
    _Connector,
    _restart,
    _teams,
)

CONVERSATION = f"{CHANNEL};messageid={ROOT}"
CARD_ID = "MSG1"
PRESSER = "aad-presser"


def _handled() -> tuple[TeamsAdapter, _Connector, list[InboundInteraction]]:
    """An adapter that takes presses, and the list of the ones it took."""
    adapter, connector = _teams()
    seen: list[InboundInteraction] = []

    async def record(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(record)
    return adapter, connector, seen


def _buttons(activity: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Every button on a card, as its title and the data it carries."""
    card = activity["attachments"][0]["content"]
    return [
        (str(action["title"]), dict(action["data"]))
        for block in card["body"]
        if block.get("type") == "ActionSet"
        for action in block["actions"]
    ]


def _posted(connector: _Connector) -> dict[str, Any]:
    return dict(connector.sends[0]["activity"])


def _edited(connector: _Connector) -> dict[str, Any]:
    return dict(connector.updates[0]["activity"])


def _press(position: int, token: str = "tok-1", **overrides: Any) -> dict[str, Any]:
    """The invoke Teams delivers when someone presses a button on the card."""
    activity: dict[str, Any] = {
        "type": "invoke",
        "name": "adaptiveCard/action",
        "serviceUrl": SERVICE_URL,
        "conversation": {"id": CONVERSATION, "conversationType": "channel"},
        "channelData": {"channel": {"id": CHANNEL}},
        "replyToId": CARD_ID,
        "from": {"id": "29:presser", "aadObjectId": PRESSER, "name": "kim"},
        "value": {
            "action": {
                "type": "Action.Execute",
                "verb": ANSWER_VERB,
                "data": {"switchAnswer": {"token": token, "position": position}},
            },
            "trigger": "manual",
        },
    }
    activity.update(overrides)
    return activity


# ── What the card offers ─────────────────────────────────────────────────────


async def test_an_open_card_offers_a_button_for_every_option_it_lists() -> None:
    """Numbered the way the body numbers them and the way a typed answer names
    them, so pressing and typing mean the same thing by the same word."""
    adapter, connector, _ = _handled()

    await adapter.post_rich(CHANNEL, AGENT, await _card(), ROOT)

    assert _buttons(_posted(connector)) == [
        ("1. Allow once", {"switchAnswer": {"token": "tok-1", "position": 1}}),
        ("2. Deny", {"switchAnswer": {"token": "tok-1", "position": 2}}),
    ]


async def test_a_press_carries_the_card_and_the_place_and_nothing_else() -> None:
    """No option id, no actor, no label. Everything a client could have
    rewritten is resolved against the record, so the less it carries the less
    there is to resolve."""
    adapter, connector, _ = _handled()

    await adapter.post_rich(CHANNEL, AGENT, await _card(), ROOT)

    for _title, data in _buttons(_posted(connector)):
        assert set(data) == {"switchAnswer"}
        assert set(data["switchAnswer"]) == {"token", "position"}
    assert "allow-once" not in str(_buttons(_posted(connector)))


async def test_the_buttons_are_executes_that_an_old_client_drops() -> None:
    """A press has to reach the bot to be answered privately, which only
    `Action.Execute` does. Wrapped in an `ActionSet` because that is where a
    client that cannot run one honours the fallback."""
    adapter, connector, _ = _handled()

    await adapter.post_rich(CHANNEL, AGENT, await _card(), ROOT)

    card = _posted(connector)["attachments"][0]["content"]
    block = card["body"][-1]
    assert block["type"] == "ActionSet"
    assert {action["type"] for action in block["actions"]} == {"Action.Execute"}
    assert {action["fallback"] for action in block["actions"]} == {"drop"}
    assert {action["verb"] for action in block["actions"]} == {ANSWER_VERB}


async def test_only_a_card_with_buttons_asks_for_the_newer_schema() -> None:
    """A client too old for 1.5 renders the whole card as its fallback text, so
    the version is raised where there is something to gain by it and nowhere
    else."""
    adapter, connector, _ = _handled()

    await adapter.post_rich(CHANNEL, AGENT, await _card(), ROOT)
    await adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT)

    assert _posted(connector)["attachments"][0]["content"]["version"] == "1.5"
    card = connector.sends[1]["activity"]["attachments"][0]["content"]
    assert card["version"] == "1.4"


async def test_the_body_still_lists_every_option_the_buttons_offer() -> None:
    """The buttons are dropped on a client that cannot run them, and a body
    that had left the options to them would leave that reader a question with
    no choices and no way to answer it."""
    adapter, connector, _ = _handled()

    await adapter.post_rich(CHANNEL, AGENT, await _card(), ROOT)

    text = _card_text(_posted(connector))
    assert "1. Allow once" in text
    assert "2. Deny" in text
    assert "R7" in text


async def test_a_long_option_is_cut_on_the_button_and_whole_in_the_body() -> None:
    """A row of buttons stops being readable long before Teams refuses one.
    Cutting is safe only because the full text is above it."""
    adapter, connector, _ = _handled()
    card = await _card()
    wordy = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={
                    "options": [
                        option.model_copy(update={"label": "Allow " + "very " * 40})
                        for option in card.request.content.options
                    ]
                }
            )
        }
    )

    await adapter.post_rich(CHANNEL, AGENT, replace(card, request=wordy), ROOT)

    titles = [title for title, _ in _buttons(_posted(connector))]
    assert all(len(title) <= 60 for title in titles)
    assert titles[0].endswith("…")
    assert "very very very" in _card_text(_posted(connector))


async def test_a_settled_card_is_redrawn_without_its_buttons() -> None:
    """A redraw rebuilds the whole card, so a settled request loses its
    controls without anything having to remember it had them."""
    adapter, connector, _ = _handled()
    card = await _card()
    ref = await adapter.post_rich(CHANNEL, AGENT, card, ROOT)

    settled = replace(
        card, request=card.request.model_copy(update={"state": "resolved"})
    )
    await adapter.update_rich(CHANNEL, AGENT, ref, settled, ROOT)

    assert _buttons(_posted(connector)) != []
    assert _buttons(_edited(connector)) == []


async def test_a_card_that_cannot_be_answered_here_offers_nothing_to_press() -> None:
    """It says why in its own words, and a live button under that sentence is
    an invitation to the refusal the sentence just explained."""
    adapter, connector, _ = _handled()

    await adapter.post_rich(
        CHANNEL,
        AGENT,
        await _card(unavailable_reason="Answer this one in the Console."),
        ROOT,
    )

    assert _buttons(_posted(connector)) == []


async def test_a_card_that_could_not_show_its_decision_offers_nothing_to_press() -> (
    None
):
    """The body says it is too long to answer here — and a button beside that
    sentence answers it anyway. The press would resolve against the saved form
    and settle the request on text the reader never saw."""
    adapter, connector, _ = _handled()
    card = await _card()
    clipped = card.request.model_copy(
        update={
            "content": card.request.content.model_copy(
                update={"detail": "Deletes the production volume. " * 2000}
            )
        }
    )

    await adapter.post_rich(CHANNEL, AGENT, replace(card, request=clipped), ROOT)

    assert "cannot be answered from this message" in _card_text(_posted(connector))
    assert _buttons(_posted(connector)) == []


async def test_a_status_has_nothing_to_press() -> None:
    adapter, connector, _ = _handled()

    await adapter.post_rich(CHANNEL, AGENT, _activity(), ROOT)

    assert _buttons(_posted(connector)) == []


async def test_a_bridge_that_takes_no_presses_draws_no_buttons() -> None:
    """Every press here arrives as an invoke that has to be answered. One
    answered with nothing to route it to is a control that spins and then
    reports a failure of its own."""
    adapter, connector = _teams()

    await adapter.post_rich(CHANNEL, AGENT, await _card(), ROOT)

    assert _buttons(_posted(connector)) == []


# ── The press that comes back ────────────────────────────────────────────────


async def test_the_card_and_the_press_agree_on_the_option() -> None:
    """The loop: the adapter draws the control, Teams hands the data back, and
    the record turns it into the option the reader pressed."""
    adapter, _connector, seen = _handled()
    card = await _card()
    reference = await adapter.post_rich(CHANNEL, AGENT, card, ROOT)

    assert await adapter._dispatch_activity(_press(2)) is None

    interaction = seen[0]
    assert interaction.value == card.reference.token
    assert interaction.message_ref == reference
    answer = resolve_pressed_position(
        posted_form(card.request),
        parse_answer_position(interaction.action_id) or 0,
    )
    assert answer is not None


async def test_a_press_on_a_card_that_outlived_the_process_is_still_addressed() -> None:
    """The conversation, the region and the message all come off the activity,
    so a press on a card posted before the last restart resolves to the same
    reference as one posted a moment ago. Nothing is read from memory."""
    adapter, _connector, seen = _handled()
    _restart(adapter)

    await adapter._dispatch_activity(_press(1))

    assert seen[0].channel_id == CHANNEL
    assert seen[0].message_ref == _publication_ref(SERVICE_URL, CONVERSATION, CARD_ID)


async def test_a_press_is_attributed_to_the_account_that_sent_it() -> None:
    """Teams fills in who pressed; the data says only which card and which
    control. An id in the data would be a claim rather than a sender."""
    adapter, _connector, seen = _handled()

    await adapter._dispatch_activity(_press(1))

    assert seen[0].sender_id == PRESSER
    assert seen[0].sender_name == "kim"


async def test_a_press_taken_without_a_refusal_shows_the_presser_nothing() -> None:
    """The card's own redraw is what says an answer was taken. Saying so here
    would be saying it before the redraw that proves it."""
    adapter, _connector, seen = _handled()

    assert await adapter._dispatch_activity(_press(1)) is None
    assert len(seen) == 1


async def test_a_refused_press_is_told_to_the_presser_and_to_nobody_else() -> None:
    """The invoke's own answer, which Teams shows to whoever pressed. The
    conversation is not told that somebody's answer did not land."""
    adapter, connector = _teams()

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id,
            interaction.sender_id,
            interaction.sender_name,
            None,
            "Your answer to R7 did not land, because that card is no longer open.",
        )

    adapter.set_interaction_handler(refuse)

    answer = await adapter._dispatch_activity(_press(1))

    assert answer is not None
    assert answer["type"] == "application/vnd.microsoft.activity.message"
    assert "no longer open" in str(answer["value"])
    assert connector.sends == []


async def test_a_typed_answers_refusal_is_still_said_in_the_cards_post() -> None:
    """There is no press to answer, so the notice goes where the base puts it:
    the card's own post, which is the only private-ish thing left."""
    adapter, connector = _teams()

    await adapter.tell_actor(
        CHANNEL,
        PRESSER,
        "kim",
        _publication_ref(SERVICE_URL, CONVERSATION, CARD_ID),
        "Not this one.",
    )

    assert "Not this one." in _posted(connector)["text"]
    assert _posted(connector)["text"].startswith("kim")


async def test_a_press_on_a_card_that_is_not_ours_is_closed_and_ignored() -> None:
    """Another app's card action, or one with data this would not read. The
    press is still answered: an unanswered one spins on the presser's client
    until it decides for itself that something broke."""
    adapter, _connector, seen = _handled()
    unreadable: list[dict[str, Any]] = [
        {},
        {"action": {"verb": "other-app/go", "data": {}}},
        {"action": {"verb": ANSWER_VERB, "data": {}}},
        {"action": {"verb": ANSWER_VERB, "data": {"switchAnswer": {"token": "tok-1"}}}},
        {
            "action": {
                "verb": ANSWER_VERB,
                "data": {"switchAnswer": {"token": "", "position": 1}},
            }
        },
        {
            "action": {
                "verb": ANSWER_VERB,
                "data": {"switchAnswer": {"token": "tok-1", "position": 0}},
            }
        },
        {
            "action": {
                "verb": ANSWER_VERB,
                "data": {"switchAnswer": {"token": "tok-1", "position": True}},
            }
        },
    ]

    for value in unreadable:
        answer = await adapter._dispatch_activity(_press(1, value=value))
        assert answer is not None
        assert answer["type"] == "application/vnd.microsoft.error"

    assert seen == []


async def test_a_press_that_names_no_card_is_refused_rather_than_guessed() -> None:
    """Without the message there is nothing to match the token against, and a
    guess at the card is how a token lifted from one gets pressed against
    another."""
    adapter, _connector, seen = _handled()

    answer = await adapter._dispatch_activity(_press(1, replyToId=""))

    assert answer is not None
    assert answer["value"]["code"] == "BadRequest"
    assert seen == []


async def test_a_press_with_nowhere_to_go_says_so_rather_than_succeeding() -> None:
    """The card should never have had buttons. Answering with an empty success
    would take the button out of its loading state as though the answer had
    landed."""
    adapter, _connector = _teams()

    answer = await adapter._dispatch_activity(_press(1))

    assert answer is not None
    assert answer["type"] == "application/vnd.microsoft.error"


async def test_a_press_whose_handling_fails_still_closes_the_press(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The failure belongs in the log, not on a button that never stops
    loading and not in an empty success that claims the answer landed."""
    adapter, _connector = _teams()

    async def explode(_interaction: InboundInteraction) -> None:
        raise RuntimeError("the room went away")

    adapter.set_interaction_handler(explode)

    with caplog.at_level(logging.ERROR):
        answer = await adapter._dispatch_activity(_press(1))

    assert answer is not None
    assert answer["statusCode"] == 500
    assert "the room went away" in caplog.text


async def test_the_answer_to_a_press_reaches_teams_as_the_invoke_response() -> None:
    """A bare 200 with no body is what every other activity gets, and it says
    nothing to the presser. The response is the only channel a refusal has."""
    adapter, _connector = _teams()
    adapter._validator = None

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            interaction.channel_id, interaction.sender_id, "kim", None, "Not yours."
        )

    adapter.set_interaction_handler(refuse)

    response = await adapter._handle_http_messages(
        _FakeHttpRequest(body=_press(1))  # type: ignore[arg-type]
    )

    assert response.status == 200
    assert b"Not yours." in response.body


async def test_an_ordinary_message_still_answers_with_a_bare_acknowledgement() -> None:
    """Only an invoke has a body to return, and a message carrying one would be
    a change in what every Teams activity has always been answered with."""
    adapter, _connector = _teams()
    adapter._validator = None

    response = await adapter._handle_http_messages(
        _FakeHttpRequest(  # type: ignore[arg-type]
            body={"type": "message", "text": "hello", "conversation": {"id": CHANNEL}}
        )
    )

    assert response.status == 200
    assert response.body in (b"", None)
