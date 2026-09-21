"""Answering a Discord permission card by pressing it.

Two things have to be true before a button is drawn at all. Discord only lets
an application-owned webhook carry interactive components, and the publication
webhook is found by name — so the one in a channel may be somebody else's, and
a card posted through it would arrive with the question and no way to press it.
And there has to be something for a press to reach; a button on a bridge that
handles no interactions is a button that does nothing.

After that it is the shape the other platforms use: the press carries the
card's opaque token and the number beside the option, both resolved against the
record rather than trusted, and the answer is attributed to the account Discord
says sent it. Nothing is remembered between the post and the press, which is
what makes a card outlive a restart.

A refusal is private. It reaches the presser as a follow-up on the press
itself, so a channel does not watch somebody be told no.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.adapter import (
    RequestCard,
    RichContentFailed,
    ThreadUnavailable,
)
from switch_core.bridges.collaboration.discord.adapter import (
    _MAX_BUTTONS,
    _PUBLICATION_WEBHOOK_NAME,
    _WEBHOOK_NAME,
    DiscordAdapter,
)
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.form import (
    posted_form,
    resolve_pressed_position,
)
from switch_core.bridges.collaboration.session.renderers import (
    Control,
    offered_controls,
    parse_answer_position,
)

from .test_discord_sdk_only import (
    BOT_USER_ID,
    CHANNEL_ID,
    DM_CHANNEL_ID,
    GUILD_ID,
    ROOT_MESSAGE_ID,
    _activity,
    _adapter,
    _card,
    _Channel,
    _DMChannel,
    _guild_setup,
    _http_error,
    _no_thread_yet,
    _Thread,
    _Webhook,
)

PRESSER_ID = 4242
PRESSER_NAME = "kim"
CARD_MESSAGE_ID = 901


# ── Fakes ────────────────────────────────────────────────────────────────────


class _Presser:
    def __init__(self) -> None:
        self.id = PRESSER_ID
        self.name = PRESSER_NAME


class _Response:
    def __init__(self) -> None:
        self.deferred = 0
        self.error: Exception | None = None

    async def defer(self) -> None:
        if self.error is not None:
            raise self.error
        self.deferred += 1


class _Followup:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.error: Exception | None = None

    async def send(self, content: str, **kwargs: Any) -> None:
        if self.error is not None:
            raise self.error
        self.sent.append({"content": content, **kwargs})


class _Interaction:
    """What the gateway hands a listener when a component is operated."""

    def __init__(
        self,
        custom_id: str,
        *,
        channel: Any,
        message: Any,
        guild_id: int | None = GUILD_ID,
        kind: discord.InteractionType = discord.InteractionType.component,
    ) -> None:
        self.type = kind
        self.guild_id = guild_id
        self.data: dict[str, Any] = {"custom_id": custom_id, "component_type": 2}
        self.channel = channel
        self.message = message
        self.user = _Presser()
        self.response = _Response()
        self.followup = _Followup()


# ── Helpers ──────────────────────────────────────────────────────────────────


def _handled(
    adapter: DiscordAdapter,
) -> list[InboundInteraction]:
    """Give `adapter` somewhere for a press to go, and return what arrived."""
    seen: list[InboundInteraction] = []

    async def took(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(took)
    return seen


def _answering() -> tuple[DiscordAdapter, _Channel, _Thread, _Webhook, list[Any]]:
    """A guild channel whose publication webhook this application owns."""
    adapter, channel, thread, webhook = _guild_setup()
    return adapter, channel, thread, webhook, _handled(adapter)


def _buttons(payload: dict[str, Any]) -> list[tuple[str, str]]:
    """Every button in a send or edit, as (label, id), in the order drawn."""
    view = payload.get("view")
    if view is None:
        return []
    return [(item.label, item.custom_id) for item in view.children]


def _message(channel: Any, message_id: int = CARD_MESSAGE_ID) -> Any:
    class _Posted:
        id = message_id

    return _Posted()


async def _post_card(
    adapter: DiscordAdapter, *, thread: bool = True, **kwargs: Any
) -> RequestCard:
    card = await _card(**kwargs)
    root = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}" if thread else None
    await adapter.post_rich(str(CHANNEL_ID), "my-agent", card, root)
    return card


def _settled(card: RequestCard) -> RequestCard:
    return replace(card, request=card.request.model_copy(update={"state": "resolved"}))


def _with_options(card: RequestCard, label: Callable[[Any], str]) -> Any:
    """The card's request with each option's label rewritten by `label`."""
    content = card.request.content
    return card.request.model_copy(
        update={
            "content": content.model_copy(
                update={
                    "options": [
                        option.model_copy(update={"label": label(option)})
                        for option in content.options
                    ]
                }
            )
        }
    )


# ── What a card offers ───────────────────────────────────────────────────────


async def test_an_open_card_offers_every_option_as_a_numbered_button() -> None:
    """The number is the one the body prints and the one a typed answer names,
    so the two ways of answering mean the same thing by the same word."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    card = await _post_card(adapter)

    offered = offered_controls(card.request)
    assert offered
    assert _buttons(webhook.sent[0]) == [
        (f"{control.position}. {control.label}", f"sw:tok-1:{control.position}")
        for control in offered
    ]


async def test_a_press_carries_the_card_and_the_option_and_nothing_else() -> None:
    """No actor, no option id, no label. What the button hands back is a token
    to resolve and a number to count to, both checked against the record."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    await _post_card(adapter)

    for _label, custom_id in _buttons(webhook.sent[0]):
        prefix, token, position = custom_id.split(":")
        assert prefix == "sw"
        assert token == "tok-1"
        assert position.isdecimal()


async def test_an_option_the_button_says_in_full_is_not_repeated_in_the_body() -> None:
    """Unlike the buttonless card, which has to print them: the body is the
    only thing carrying the options there."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    card = await _post_card(adapter)
    with_buttons = webhook.sent[0]["content"]

    plain, _channel2, _thread2, plain_webhook = _guild_setup()
    await plain.post_rich(
        str(CHANNEL_ID), "my-agent", card, f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    label = offered_controls(card.request)[0].label
    assert label in plain_webhook.sent[0]["content"]
    assert label not in with_buttons


async def test_an_option_too_long_for_its_button_is_kept_whole_in_the_body() -> None:
    """A cut label is the shortest way to say which option, not the option. The
    reader has to be able to see what they are agreeing to somewhere."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    card = await _card()
    wordy = replace(
        card, request=_with_options(card, lambda option: "Allow " + "very " * 40)
    )

    await adapter.post_rich(str(CHANNEL_ID), "my-agent", wordy, None)

    label, _custom_id = _buttons(webhook.sent[0])[0]
    assert len(label) <= 80
    assert label.endswith("…")
    assert "very very very" in webhook.sent[0]["content"]


# ── What a refusal is reported with ──────────────────────────────────────────


async def test_a_refused_edit_reports_the_options_the_card_stopped_printing() -> None:
    """The one that actually reaches a reader.

    A card whose redraw is refused travels as the text of a
    `RichContentFailed`, and the publisher forwards that as an ordinary
    message — where there are no buttons to carry the options. The drawing that
    was going on the card is the wrong one to report with, because it left out
    every option a button was going to say in full.
    """
    adapter, _channel, _thread, webhook, _seen = _answering()
    card = await _post_card(adapter)
    webhook.edit_error = _http_error(403)

    with pytest.raises(RichContentFailed) as raised:
        await adapter.update_rich(
            str(CHANNEL_ID),
            "my-agent",
            f"{ROOT_MESSAGE_ID}:{CARD_MESSAGE_ID}",
            card,
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        )

    label = offered_controls(card.request)[0].label
    assert label in raised.value.text
    assert label not in webhook.sent[0]["content"]


async def test_a_refused_post_reports_the_options_its_buttons_never_got() -> None:
    """Nothing was posted, so the reported text is the only place the options
    appear at all."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    card = await _card()
    webhook.send_error = _http_error(403)

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", card, None)

    assert offered_controls(card.request)[0].label in raised.value.text


async def test_a_refused_dm_card_reports_the_options_the_bot_could_not_send() -> None:
    """A DM card is the bot's own message and always earns buttons, so this is
    the path where the body most reliably has the options left out of it."""
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    _handled(adapter)
    card = await _card()
    dm.send_error = _http_error(403)

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", card, None)

    assert offered_controls(card.request)[0].label in raised.value.text


async def test_a_card_with_nowhere_to_go_says_what_it_was_asking() -> None:
    """`ThreadUnavailable` carries a text too, and the caller posts it at the
    channel root when the thread it was meant for has gone."""
    adapter, channel, _webhook = _no_thread_yet()
    _handled(adapter)
    channel.thread_error = _http_error(403)
    card = await _card()

    with pytest.raises(ThreadUnavailable) as raised:
        await adapter.post_rich(
            str(CHANNEL_ID), "my-agent", card, f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
        )

    assert offered_controls(card.request)[0].label in raised.value.text


async def test_a_settled_card_is_redrawn_with_its_buttons_taken_off() -> None:
    """`view=None` rather than nothing at all: an edit that leaves the
    components alone leaves a settled card inviting a press."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    settled = _settled(await _card())

    await adapter.update_rich(
        str(CHANNEL_ID),
        "my-agent",
        f"{ROOT_MESSAGE_ID}:{CARD_MESSAGE_ID}",
        settled,
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
    )

    assert "view" in webhook.edits[0]
    assert webhook.edits[0]["view"] is None


async def test_a_card_that_cannot_be_answered_here_offers_no_press() -> None:
    """A live control under the sentence explaining why an answer cannot land
    is an invitation to the refusal it just explained."""
    adapter, _channel, _thread, webhook, _seen = _answering()

    await _post_card(adapter, unavailable_reason="this channel is read-only")

    assert _buttons(webhook.sent[0]) == []


async def test_a_turn_status_offers_no_press() -> None:
    adapter, _channel, _thread, webhook, _seen = _answering()

    await adapter.post_rich(str(CHANNEL_ID), "my-agent", _activity(), None)

    assert _buttons(webhook.sent[0]) == []


async def test_a_bridge_that_takes_no_presses_draws_no_buttons() -> None:
    """The handler is what a press reaches. Without one the card is answerable
    by typing and says so, rather than offering a control that goes nowhere."""
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)

    assert _buttons(webhook.sent[0]) == []


async def test_more_options_than_discord_shows_gets_none_of_them(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Some of the choices reads as all of them. A card that cannot show the
    whole list shows none and is answered by typing."""
    adapter, _channel, _thread, webhook, _seen = _answering()
    card = await _card()
    content = card.request.content
    crowded = replace(
        card,
        request=card.request.model_copy(
            update={
                "content": content.model_copy(
                    update={
                        "options": [
                            content.options[0].model_copy(
                                update={"option_id": f"o{n}", "label": f"Option {n}"}
                            )
                            for n in range(_MAX_BUTTONS + 1)
                        ]
                    }
                )
            }
        ),
    )

    with caplog.at_level(logging.WARNING):
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", crowded, None)

    assert _buttons(webhook.sent[0]) == []
    assert "typing only" in caplog.text
    assert "Option 3" in webhook.sent[0]["content"]


async def test_the_view_is_never_left_in_the_clients_own_store() -> None:
    """Nothing here waits on discord.py's dispatch — a press arrives as a
    gateway interaction. An unstopped view would be filed against the message
    for the life of the process, one per card ever posted."""
    adapter, _channel, _thread, webhook, _seen = _answering()

    await _post_card(adapter)

    assert webhook.sent[0]["view"].is_finished() is True


# ── Which webhook may carry a button ─────────────────────────────────────────


async def test_a_webhook_this_application_made_may_carry_buttons() -> None:
    adapter, _channel, _thread, webhook, _seen = _answering()

    await _post_card(adapter)

    assert _buttons(webhook.sent[0])


async def test_a_webhook_somebody_else_made_carries_none_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Discord drops components from a webhook it does not consider an
    application's. Finding one by name proves nothing about who made it."""
    adapter, channel, _thread, _webhook = _guild_setup()
    _handled(adapter)
    channel.existing_webhooks = [
        _Webhook(_WEBHOOK_NAME),
        _Webhook(_PUBLICATION_WEBHOOK_NAME, creator=BOT_USER_ID + 1),
    ]
    theirs = channel.existing_webhooks[1]

    with caplog.at_level(logging.WARNING):
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)

    assert _buttons(theirs.sent[0]) == []
    assert "not let it carry buttons" in caplog.text
    assert "answered by typing" in caplog.text


async def test_a_webhook_of_unknown_making_is_not_taken_for_ours() -> None:
    """Discord leaves the creator out when a webhook is read by its token. An
    absent answer is not a yes."""
    adapter, channel, _thread, _webhook = _guild_setup()
    _handled(adapter)
    channel.existing_webhooks = [
        _Webhook(_WEBHOOK_NAME),
        _Webhook(_PUBLICATION_WEBHOOK_NAME, creator=None),
    ]

    await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)

    assert _buttons(channel.existing_webhooks[1].sent[0]) == []


async def test_a_webhook_the_bridge_had_to_mint_is_ours_by_construction() -> None:
    """Nothing else made it, so nothing has to be read back to know that."""
    channel = _Channel()
    adapter = _adapter({CHANNEL_ID: channel})
    _handled(adapter)

    await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)

    minted = channel.existing_webhooks[-1]
    assert minted.name == _PUBLICATION_WEBHOOK_NAME
    assert _buttons(minted.sent[0])


async def test_somebody_elses_webhook_is_used_rather_than_replaced() -> None:
    """A webhook may only edit and delete the messages it sent. Swapping it
    would strand every card already posted through it, so the cards stay where
    they are and lose their buttons instead."""
    adapter, channel, _thread, _webhook = _guild_setup()
    _handled(adapter)
    channel.existing_webhooks = [
        _Webhook(_WEBHOOK_NAME),
        _Webhook(_PUBLICATION_WEBHOOK_NAME, creator=BOT_USER_ID + 1),
    ]

    await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)

    assert len(channel.existing_webhooks) == 2
    assert channel.existing_webhooks[1].sent


# ── A card in a DM ───────────────────────────────────────────────────────────


async def test_a_card_in_a_dm_gets_buttons_on_the_bots_own_message() -> None:
    """There is no webhook in a DM to own or not own, and a bot may always put
    components on a message it wrote itself."""
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    _handled(adapter)

    await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", await _card(), None)

    assert _buttons(dm.sent[0])


async def test_a_settled_card_in_a_dm_loses_its_buttons_too() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    _handled(adapter)
    await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", await _card(), None)
    posted = dm.messages[501]
    settled = _settled(await _card())

    await adapter.update_rich(
        str(DM_CHANNEL_ID), "my-agent", f"{DM_CHANNEL_ID}:501", settled, None
    )

    assert posted.edits[0]["view"] is None


# ── A press ──────────────────────────────────────────────────────────────────


async def test_a_press_names_the_option_the_reader_was_looking_at() -> None:
    """End to end through the shared seam: the number on the button resolves
    against the form the card was posted with."""
    adapter, _channel, thread, webhook, seen = _answering()
    card = await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[1]

    await adapter._handle_interaction(
        _Interaction(custom_id, channel=thread, message=_message(thread))
    )

    assert len(seen) == 1
    assert seen[0].value == card.reference.token
    answer = resolve_pressed_position(
        posted_form(card.request),
        parse_answer_position(seen[0].action_id) or 0,
    )
    assert answer is not None


async def test_a_press_in_a_thread_is_addressed_the_way_the_card_was() -> None:
    """The card was recorded against the parent channel and the thread's own
    message. A press has to resolve to the same two, or the shared layer sees
    an answer about some other card and ignores it."""
    adapter, _channel, thread, webhook, seen = _answering()
    reference = await adapter.post_rich(
        str(CHANNEL_ID), "my-agent", await _card(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )
    _label, custom_id = _buttons(webhook.sent[0])[0]

    await adapter._handle_interaction(
        _Interaction(custom_id, channel=thread, message=_message(thread))
    )

    assert seen[0].channel_id == str(CHANNEL_ID)
    assert seen[0].message_ref == reference


async def test_a_press_in_a_dm_is_addressed_to_the_dm() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    seen = _handled(adapter)
    reference = await adapter.post_rich(
        str(DM_CHANNEL_ID), "my-agent", await _card(), None
    )
    _label, custom_id = _buttons(dm.sent[0])[0]

    await adapter._handle_interaction(
        _Interaction(custom_id, channel=dm, message=_message(dm, 501), guild_id=None)
    )

    assert seen[0].channel_id == str(DM_CHANNEL_ID)
    assert seen[0].message_ref == reference


async def test_a_press_on_a_card_that_outlived_the_process_still_resolves() -> None:
    """Nothing is remembered between the post and the press: the card comes off
    the message the press arrived on, so an adapter that has never seen it
    addresses it the same way."""
    _poster, channel, thread, webhook, _seen = _answering()
    reference = await _poster.post_rich(
        str(CHANNEL_ID), "my-agent", await _card(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )
    _label, custom_id = _buttons(webhook.sent[0])[0]

    restarted = _adapter({CHANNEL_ID: channel, ROOT_MESSAGE_ID: thread})
    seen = _handled(restarted)
    await restarted._handle_interaction(
        _Interaction(custom_id, channel=thread, message=_message(thread))
    )

    assert seen[0].message_ref == reference


async def test_a_press_is_attributed_to_the_account_discord_says_sent_it() -> None:
    """The id in the button says which card and which option, never who. An
    actor carried in the payload would be a claim rather than a sender."""
    adapter, _channel, thread, webhook, seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]

    await adapter._handle_interaction(
        _Interaction(custom_id, channel=thread, message=_message(thread))
    )

    assert seen[0].sender_id == str(PRESSER_ID)
    assert seen[0].sender_name == PRESSER_NAME


async def test_a_press_is_acknowledged_before_switch_is_asked_anything() -> None:
    """Discord allows three seconds and the authority check is not bounded by
    them. An unacknowledged press is one the presser is told failed."""
    adapter, _channel, thread, webhook, _seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]
    order: list[str] = []

    async def took(interaction: InboundInteraction) -> None:
        order.append("answered")

    adapter.set_interaction_handler(took)
    press = _Interaction(custom_id, channel=thread, message=_message(thread))

    original = press.response.defer

    async def defer() -> None:
        order.append("acknowledged")
        await original()

    press.response.defer = defer  # type: ignore[method-assign]
    await adapter._handle_interaction(press)

    assert order == ["acknowledged", "answered"]


async def test_a_press_discord_would_not_acknowledge_is_not_answered(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Past the window the presser is shown a failure whatever happens next, so
    an answer taken after it would settle a request nobody was told about."""
    adapter, _channel, thread, webhook, seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]
    press = _Interaction(custom_id, channel=thread, message=_message(thread))
    press.response.error = discord.HTTPException(_HttpResponse(), "too late")  # type: ignore[arg-type]

    with caplog.at_level(logging.ERROR):
        await adapter._handle_interaction(press)

    assert seen == []
    assert "not attempted" in caplog.text


async def test_a_clean_press_says_nothing_to_anybody() -> None:
    """The card's own redraw is what says an answer was taken. Saying so here
    would be claiming it before the redraw that proves it."""
    adapter, channel, thread, webhook, _seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]
    press = _Interaction(custom_id, channel=thread, message=_message(thread))

    await adapter._handle_interaction(press)

    assert press.followup.sent == []
    assert channel.sent == []
    assert thread.sent == []


async def test_a_refused_press_is_explained_to_the_presser_alone() -> None:
    """A refusal names the person and the reason, and a channel does not need
    to watch somebody be told no."""
    adapter, channel, thread, webhook, _seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            str(CHANNEL_ID),
            str(PRESSER_ID),
            PRESSER_NAME,
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
            "That request was answered already.",
        )

    adapter.set_interaction_handler(refuse)
    press = _Interaction(custom_id, channel=thread, message=_message(thread))
    await adapter._handle_interaction(press)

    assert press.followup.sent == [
        {"content": "That request was answered already.", "ephemeral": True}
    ]
    assert channel.sent == []
    assert thread.sent == []


async def test_a_refusal_discord_will_not_carry_is_logged_and_left(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing downstream waits on it, and the answer it explains was decided
    either way."""
    adapter, _channel, thread, webhook, _seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]

    async def refuse(interaction: InboundInteraction) -> None:
        await adapter.tell_actor(
            str(CHANNEL_ID), str(PRESSER_ID), PRESSER_NAME, None, "Not yours to answer."
        )

    adapter.set_interaction_handler(refuse)
    press = _Interaction(custom_id, channel=thread, message=_message(thread))
    press.followup.error = discord.HTTPException(_HttpResponse(), "gone")  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING):
        await adapter._handle_interaction(press)

    assert "went unsaid" in caplog.text
    assert "Not yours to answer." in caplog.text


async def test_a_typed_answers_refusal_is_still_said_in_the_cards_thread() -> None:
    """There is no press to follow up, so it falls back to the base: said where
    the card is, which is the only reply Discord gives a bot unprompted."""
    adapter, _channel, thread, _webhook, _seen = _answering()

    await adapter.tell_actor(
        str(CHANNEL_ID),
        str(PRESSER_ID),
        PRESSER_NAME,
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "Not this one.",
    )

    assert thread.sent
    assert "Not this one." in thread.sent[0]["content"]


# ── A press that is not ours ─────────────────────────────────────────────────


async def test_a_press_this_bridge_did_not_write_is_left_alone() -> None:
    """Every shape that is not a Switch answer: another app's control, a
    truncated one, a position that is not a count, and one that is not a
    number at all."""
    adapter, _channel, thread, _webhook, seen = _answering()

    for custom_id in (
        "",
        "other:tok-1:1",
        "sw:tok-1",
        "sw::1",
        "sw:tok-1:",
        "sw:tok-1:0",
        "sw:tok-1:-1",
        "sw:tok-1:٢",
        "sw:tok-1:1:2",
        "sw:tok-1:two",
    ):
        press = _Interaction(custom_id, channel=thread, message=_message(thread))
        await adapter._handle_interaction(press)
        assert press.response.deferred == 0, custom_id

    assert seen == []


async def test_an_interaction_that_is_not_a_press_is_left_to_the_command_tree() -> None:
    """A slash command arrives on the same event, and the tree handles it."""
    adapter, _channel, thread, webhook, seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]

    await adapter._handle_interaction(
        _Interaction(
            custom_id,
            channel=thread,
            message=_message(thread),
            kind=discord.InteractionType.application_command,
        )
    )

    assert seen == []


async def test_a_press_from_another_guild_is_not_this_bridges_business() -> None:
    adapter, _channel, thread, webhook, seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]

    await adapter._handle_interaction(
        _Interaction(
            custom_id, channel=thread, message=_message(thread), guild_id=GUILD_ID + 1
        )
    )

    assert seen == []


async def test_a_press_with_nowhere_to_go_is_said_out_loud(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The card should never have been drawn with buttons, so this is a bug
    report rather than a refusal."""
    adapter, _channel, thread, _webhook = _guild_setup()
    press = _Interaction("sw:tok-1:1", channel=thread, message=_message(thread))

    with caplog.at_level(logging.WARNING):
        await adapter._handle_interaction(press)

    assert "nowhere to go" in caplog.text
    assert press.response.deferred == 0


async def test_a_handler_that_raises_is_logged_rather_than_thrown_at_discord(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The gateway listener is an event loop: one bad press must not take the
    connection down with it."""
    adapter, _channel, thread, webhook, _seen = _answering()
    await _post_card(adapter)
    _label, custom_id = _buttons(webhook.sent[0])[0]

    async def explode(interaction: InboundInteraction) -> None:
        raise RuntimeError("no")

    adapter.set_interaction_handler(explode)
    listener = adapter._make_on_interaction()

    with caplog.at_level(logging.ERROR):
        await listener(
            _Interaction(custom_id, channel=thread, message=_message(thread))  # type: ignore[arg-type]
        )

    assert "Failed to handle a press on a Discord card" in caplog.text


# ── The pieces the rest of it rests on ───────────────────────────────────────


def test_a_buttons_label_is_numbered_the_way_the_body_numbers_it() -> None:
    from switch_core.bridges.collaboration.discord.adapter import _button_label

    assert _button_label(Control(position=2, label="Deny")) == "2. Deny"
    assert _button_label(Control(position=1, label="  ")) == "1. Option 1"


class _HttpResponse:
    status = 400
    reason = "Bad Request"
    headers: dict[str, str] = {}
