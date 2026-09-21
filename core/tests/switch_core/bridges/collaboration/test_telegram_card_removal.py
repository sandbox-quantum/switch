"""Taking a Telegram card back, and being able to say whether it worked.

A bot deletes its own messages in a group as an ordinary member, which is all
the install asks for, and in a broadcast channel under the Delete Messages
right it does ask for. The limit worth knowing is time: after 48 hours Telegram
refuses, and says so, and a card open that long stays where it is.

The other half is that a caller acting on the result — writing down that a card
is gone — must not be told success where none was established. That is why this
is not `delete_message`, which logs and returns either way.
"""

from __future__ import annotations

import logging

import pytest
from telegram.error import BadRequest, Forbidden, RetryAfter, TimedOut

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)

from .test_telegram_adapter import BOT_USERNAME, CHAT_ID, _adapter, _bot

CARD_ID = 777
CARD = f"{CHAT_ID}:{CARD_ID}"
CHANNEL = str(CHAT_ID)

# What Telegram answers with once a message is more than two days old. Written
# out because the classification turns on the text, so a change to it is a
# change this file should fail on rather than absorb.
TOO_OLD = "Bad Request: message can't be deleted for everyone"
NOT_THERE = "Bad Request: message to delete not found"


async def test_a_card_is_taken_back_from_the_chat_that_holds_it() -> None:
    """The reference carries the chat Telegram echoed back, which is the one
    that outlives a supergroup migration. It wins over the channel argument."""
    adapter = _adapter()

    await adapter.remove_publication("@handle-that-moved", CARD)

    assert _bot(adapter).deletes == [{"chat_id": CHAT_ID, "message_id": CARD_ID}]


async def test_a_card_too_old_to_delete_is_a_failure_not_a_removal() -> None:
    """Telegram's 48-hour limit. The card stays where it is, settled and
    readable, and the caller must not record it as gone — a row saying so is a
    card nothing will ever look at again."""
    adapter = _adapter()
    _bot(adapter).delete_error = BadRequest(TOO_OLD)

    with pytest.raises(RemovalFailed) as raised:
        await adapter.remove_publication(CHANNEL, CARD)

    assert isinstance(raised.value.__cause__, BadRequest)


async def test_a_bot_thrown_out_of_the_chat_is_a_failure_too() -> None:
    """A definite refusal that is not about the message. Nothing was deleted,
    so nothing may be recorded."""
    adapter = _adapter()
    _bot(adapter).delete_error = Forbidden("bot was kicked")

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARD)


async def test_a_card_already_gone_is_reported_as_gone_but_said_out_loud(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing remains at the address, which is what the caller asked for, so
    this is not a failure — and it is how a deletion whose acknowledgement was
    lost settles itself on the next attempt."""
    adapter = _adapter()
    _bot(adapter).delete_error = BadRequest(NOT_THERE)

    with caplog.at_level(logging.WARNING):
        await adapter.remove_publication(CHANNEL, CARD)

    assert "already gone" in caplog.text


async def test_being_asked_to_wait_is_kept_apart_from_being_refused() -> None:
    """A rate limit says nothing about the card, so it must not arrive as
    `RemovalFailed`: the caller's backoff would then double its own interval
    against a delay Telegram had already named."""
    adapter = _adapter()
    _bot(adapter).delete_error = RetryAfter(31)

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(CHANNEL, CARD)

    assert raised.value.retry_after == 31


async def test_a_rate_limit_is_charged_to_the_bot_and_remembered() -> None:
    """Telegram limits the bot, not the message, so a throttled deletion is
    the whole bridge being asked for quiet. Recording it is what stops the
    next publication in any chat discovering the same thing for itself."""
    adapter = _adapter()
    _bot(adapter).delete_error = RetryAfter(31)

    with pytest.raises(RichContentThrottled):
        await adapter.remove_publication(CHANNEL, CARD)

    assert adapter._rich_update_cooldown.remaining() > 25


async def test_a_wait_already_running_is_not_walked_into_again() -> None:
    """A deletion sent inside a 429 is a second refusal and a longer wait. It
    is not sent, and the caller is told how long is left rather than that the
    card could not be removed."""
    adapter = _adapter()
    adapter._rich_update_cooldown.start(20)

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(CHANNEL, CARD)

    assert raised.value.retry_after > 0
    assert _bot(adapter).deletes == []


async def test_a_request_that_never_came_back_is_owed_rather_than_settled() -> None:
    """An uncertain send has to keep its reservation, because a second attempt
    would post a second card. A deletion has no such twin: asking again about
    one that did land is answered with "not found", so the uncertain case
    joins the refusals and is simply owed."""
    adapter = _adapter()
    _bot(adapter).delete_error = TimedOut()

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARD)


async def test_an_unparseable_reference_never_reaches_telegram() -> None:
    """A bare message id would be deleted from whatever chat was passed
    alongside it, and a non-numeric one is an `int()` away from raising
    halfway through. Refusing first is the only safe reading."""
    adapter = _adapter()

    for reference in ("nonsense", f"{CHAT_ID}:", ":777", f"{CHAT_ID}:abc"):
        with pytest.raises(RemovalFailed):
            await adapter.remove_publication(CHANNEL, reference)

    assert _bot(adapter).deletes == []


async def test_a_disconnected_adapter_does_not_claim_the_card_was_removed() -> None:
    """Nothing was asked of Telegram, so nothing is known about the card."""
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARD)


def test_telegram_is_a_platform_that_says_it_can_do_this() -> None:
    """The capability is what routes an answered card here at all."""
    assert TelegramAdapter.removes_answered_cards is True
