"""Telegram confirms an account link by a tap in the person's chat with the bot.

The prompt goes to the person's private chat, whose id is their own, with the
numbers on one row and `Not me` on the next. Each button carries the payload a
card's buttons carry, so a press comes back through the ordinary press path
naming the same message the send returned, and settling it edits that message
and takes the buttons off. A bot may only message someone who has started a
chat with it, and that refusal is told to the Switch user as a reason to use
the code.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from telegram.error import BadRequest, Forbidden, TelegramError

from switch_core.account_links import new_prompt_token
from switch_core.bridges.collaboration.link_prompts import NOT_ME_LABEL, compose_prompt
from switch_core.bridges.collaboration.models import (
    DirectMessageUnavailable,
    DirectPrompt,
    InboundInteraction,
)
from switch_core.bridges.collaboration.session.renderers import position_action
from switch_core.bridges.collaboration.telegram.adapter import (
    _MAX_CALLBACK_BYTES,
    TelegramAdapter,
    TelegramConnectionConfig,
    _press_action,
)

from .test_telegram_adapter import (
    BOT_USERNAME,
    _adapter,
    _bot,
    _FakeCallbackQuery,
    _FakeChat,
    _FakeSentMessage,
    _FakeUpdate,
    _FakeUser,
)

PERSON_ID = 5550001
PERSON = str(PERSON_ID)


def _prompt(token: str = "lnk.AbCdEfGhIjKlMnOp") -> DirectPrompt:
    return compose_prompt(
        requester_name="Ada Lovelace",
        requester_email="ada@example.com",
        platform="Telegram",
        choices=[12, 47, 83],
        token=token,
        escape=lambda text: text,
    )


def _rows(markup: Any) -> list[list[dict[str, Any]]]:
    """The keyboard as it goes on the wire."""
    return markup.to_dict()["inline_keyboard"]  # type: ignore[no-any-return]


async def test_the_prompt_goes_to_the_persons_own_chat_rendered_as_html() -> None:
    adapter = _adapter()

    ref = await adapter.send_direct_prompt(PERSON, _prompt())

    # Telegram links no message in a private chat, so the link opens the chat.
    assert adapter.direct_prompt_link(ref) == f"https://t.me/{BOT_USERNAME}"

    [sent] = _bot(adapter).messages
    assert sent["chat_id"] == PERSON_ID
    assert sent["parse_mode"] == "HTML"
    assert "<b>Ada Lovelace</b>" in sent["text"]
    assert "**" not in sent["text"]


async def test_the_numbers_share_a_row_and_not_me_has_its_own_in_red() -> None:
    adapter = _adapter()

    await adapter.send_direct_prompt(PERSON, _prompt("lnk.tok"))

    assert _rows(_bot(adapter).messages[0]["reply_markup"]) == [
        [
            {"text": "12", "callback_data": "sw:lnk.tok:1"},
            {"text": "47", "callback_data": "sw:lnk.tok:2"},
            {"text": "83", "callback_data": "sw:lnk.tok:3"},
        ],
        [
            {
                "text": NOT_ME_LABEL,
                "callback_data": "sw:lnk.tok:4",
                "style": "danger",
            }
        ],
    ]


async def test_every_button_of_a_real_token_fits_and_reads_back_as_its_position() -> (
    None
):
    """The token is sized for Telegram's 64-byte payload; this is the check
    that it still fits beside a position, and that the press path reads the
    pair back the way the prompt wrote it."""
    adapter = _adapter()
    token = new_prompt_token()

    await adapter.send_direct_prompt(PERSON, _prompt(token))

    buttons = [
        button
        for row in _rows(_bot(adapter).messages[0]["reply_markup"])
        for button in row
    ]
    assert len(buttons) == 4
    for position, button in enumerate(buttons, start=1):
        data = button["callback_data"]
        assert len(data.encode()) <= _MAX_CALLBACK_BYTES
        assert _press_action(data) == (position_action(position), token)


async def test_a_press_in_the_private_chat_names_the_message_the_send_returned() -> (
    None
):
    """Nothing about the chat being private turns the press away, and the ref
    it carries is the one settling needs, so the answer replaces the prompt
    itself."""
    adapter = _adapter()
    token = new_prompt_token()
    ref = await adapter.send_direct_prompt(PERSON, _prompt(token))
    chat_id, message_id = ref.split(":")
    seen: list[InboundInteraction] = []

    async def settle(interaction: InboundInteraction) -> None:
        seen.append(interaction)
        assert interaction.message_ref is not None
        await adapter.settle_direct_prompt(interaction.message_ref, "Linked.")

    adapter.set_interaction_handler(settle)
    private = _FakeChat(PERSON_ID, chat_type="private", title=None)
    await adapter._handle_update(
        _FakeUpdate(
            callback_query=_FakeCallbackQuery(
                data=f"sw:{token}:2",
                message=_FakeSentMessage(private, int(message_id)),
                from_user=_FakeUser(PERSON_ID, username="ada"),
            )
        )
    )

    assert chat_id == PERSON
    assert seen == [
        InboundInteraction(
            channel_id=PERSON,
            sender_id=PERSON,
            sender_name="ada",
            sender_display_name="Alice",
            action_id=position_action(2),
            value=token,
            message_ref=ref,
        )
    ]
    [edit] = _bot(adapter).edits
    assert (edit["chat_id"], edit["message_id"]) == (PERSON_ID, int(message_id))
    assert _bot(adapter).answers == [
        {"callback_query_id": "cq-1", "text": None, "show_alert": False}
    ]


@pytest.mark.parametrize(
    "refusal",
    [
        Forbidden("Forbidden: bot can't initiate conversation with a user"),
        Forbidden("Forbidden: bot was blocked by the user"),
        BadRequest("Chat not found"),
    ],
)
async def test_a_person_the_bot_may_not_message_is_told_to_use_the_code(
    refusal: TelegramError,
) -> None:
    adapter = _adapter()
    _bot(adapter).send_message_error = refusal

    with pytest.raises(DirectMessageUnavailable) as unavailable:
        await adapter.send_direct_prompt(PERSON, _prompt())

    reason = str(unavailable.value)
    assert "use the code instead" in reason
    assert f"@{BOT_USERNAME}" in reason
    assert unavailable.value.__cause__ is refusal


async def test_any_other_refusal_is_raised_as_it_came() -> None:
    """Not a reason to use the code a Switch user can act on, but a fault, so
    it reaches the sender's log rather than being worded as one."""
    adapter = _adapter()
    refusal = BadRequest("Can't parse entities: unsupported start tag")
    _bot(adapter).send_message_error = refusal

    with pytest.raises(BadRequest) as raised:
        await adapter.send_direct_prompt(PERSON, _prompt())

    assert raised.value is refusal


async def test_the_shared_app_sends_no_prompt_its_press_could_not_reach() -> None:
    """The webhook route finds an update's organisation by its chat, and a
    person's chat with the shared bot belongs to none."""
    adapter = TelegramAdapter(config=TelegramConnectionConfig(event_delivery="shared"))
    bot = _bot(_adapter())
    adapter._bot = bot

    with pytest.raises(DirectMessageUnavailable) as unavailable:
        await adapter.send_direct_prompt(PERSON, _prompt())

    assert "use the code instead" in str(unavailable.value)
    assert bot.messages == []


async def test_settling_rewrites_the_prompt_and_takes_its_buttons_off() -> None:
    adapter = _adapter()

    await adapter.settle_direct_prompt(f"{PERSON}:501", "**Linked** to Ada.")

    [edit] = _bot(adapter).edits
    assert edit["chat_id"] == PERSON_ID
    assert edit["message_id"] == 501
    assert edit["text"] == "<b>Linked</b> to Ada."
    assert edit["parse_mode"] == "HTML"
    assert edit["reply_markup"] is None


@pytest.mark.parametrize(
    "failure",
    [
        BadRequest("Message to edit not found"),
        Forbidden("Forbidden: bot was blocked by the user"),
        RuntimeError("the connection went away"),
    ],
)
async def test_settling_never_raises_and_says_what_was_answered(
    failure: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    """The answer is already recorded; a prompt left showing its buttons only
    invites a tap that will be told so."""
    adapter = _adapter()
    _bot(adapter).edit_error = failure

    with caplog.at_level(logging.WARNING):
        await adapter.settle_direct_prompt(f"{PERSON}:501", "Cancelled.")

    assert any(
        "Could not replace Telegram prompt" in record.getMessage()
        and "Cancelled." in record.getMessage()
        for record in caplog.records
    )


async def test_settling_without_a_bot_logs_rather_than_raises(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter()
    adapter._bot = None

    with caplog.at_level(logging.WARNING):
        await adapter.settle_direct_prompt(f"{PERSON}:501", "Cancelled.")

    assert any(
        "Could not replace Telegram prompt" in record.getMessage()
        for record in caplog.records
    )
