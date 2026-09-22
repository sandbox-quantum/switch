"""Taking a Discord card back, and being able to say whether it worked.

A card is posted by the publication webhook, and a webhook may delete what it
sent — so no Manage Messages permission is needed, which matters because the
documented install does not grant one. In a DM there is no webhook and the card
is the bot's own message, which it may always delete.

The other half is that a caller acting on the result — writing down that a card
is gone — must not be told success where none was established. That is why this
is not `delete_message`, which logs and returns either way.
"""

from __future__ import annotations

import logging
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.discord.adapter import (
    _PUBLICATION_WEBHOOK_NAME,
    _WEBHOOK_NAME,
    DiscordAdapter,
    DiscordConnectionConfig,
)

from .test_discord_sdk_only import (
    CHANNEL_ID,
    DM_CHANNEL_ID,
    GUILD_ID,
    ROOT_MESSAGE_ID,
    _adapter,
    _DMChannel,
    _guild_setup,
    _http_error,
    _Message,
    _Response,
    _Webhook,
)

CARD_ID = 9999
CARD = f"{CHANNEL_ID}:{CARD_ID}"
THREADED_CARD = f"{ROOT_MESSAGE_ID}:{CARD_ID}"


def _unknown_message() -> discord.NotFound:
    """The 404 that is about the message — the only one that can mean absence."""
    return discord.NotFound(  # type: ignore[arg-type]
        _Response(), {"code": 10008, "message": "Unknown Message"}
    )


def _unknown_webhook() -> discord.NotFound:
    """The 404 that is about the webhook, and carries the same HTTP status."""
    return discord.NotFound(  # type: ignore[arg-type]
        _Response(), {"code": 10015, "message": "Unknown Webhook"}
    )


def _recording(lookup: Any, seen: list[int]) -> Any:
    def record(channel_id: int) -> Any:
        seen.append(channel_id)
        return lookup(channel_id)

    return record


def _dm_setup() -> tuple[DiscordAdapter, _DMChannel]:
    channel = _DMChannel()
    return _adapter({DM_CHANNEL_ID: channel}), channel


async def test_a_card_is_taken_back_through_the_webhook_that_posted_it() -> None:
    """Not the bot, and not the agents' webhook. A webhook may only delete its
    own messages, and the publication webhook is what sent the card."""
    adapter, channel, _thread, publication = _guild_setup()
    agents = channel.existing_webhooks[0]

    await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert publication.deletes == [{"message_id": CARD_ID}]
    assert agents.deletes == []


async def test_a_card_in_a_thread_names_the_thread_it_is_in() -> None:
    """A webhook belongs to the parent channel, so the thread has to be passed
    alongside the id. Without it Discord looks at the channel root and reports
    a message that is plainly there as missing."""
    adapter, _channel, _thread, publication = _guild_setup()

    await adapter.remove_publication(str(CHANNEL_ID), THREADED_CARD)

    assert len(publication.deletes) == 1
    assert publication.deletes[0]["message_id"] == CARD_ID
    assert publication.deletes[0]["thread"].id == ROOT_MESSAGE_ID


async def test_a_card_in_a_dm_is_deleted_as_the_bot_s_own_message() -> None:
    """A DM has no webhooks at all — asking for one raises — so the card was
    posted by the bot and comes back the same way."""
    adapter, channel = _dm_setup()

    await adapter.remove_publication(str(DM_CHANNEL_ID), f"{DM_CHANNEL_ID}:{CARD_ID}")

    assert channel.deleted_ids == [CARD_ID]


async def test_a_refusal_is_raised_rather_than_logged() -> None:
    """The caller records that the card is gone. A refusal it never hears about
    is a record saying a card in the channel is not there, and the publisher
    then stops redrawing a card that still offers buttons."""
    adapter, _channel, _thread, publication = _guild_setup()
    publication.delete_error = _http_error(403)

    with pytest.raises(RemovalFailed) as raised:
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert isinstance(raised.value.__cause__, discord.HTTPException)


async def test_a_card_already_gone_is_reported_as_gone_but_said_out_loud(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing remains at the address, which is what the caller asked for, so
    this is not a failure. It is still worth a line: it is also what a deletion
    by hand looks like."""
    adapter, _channel, _thread, publication = _guild_setup()
    publication.delete_error = _unknown_message()

    with caplog.at_level(logging.WARNING):
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert "already gone" in caplog.text


async def test_a_dm_card_already_gone_is_treated_the_same_way(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The DM path deletes through a different call, so it needs its own
    evidence that a missing message is not an error."""
    adapter, channel = _dm_setup()
    channel.delete_error = _unknown_message()

    with caplog.at_level(logging.WARNING):
        await adapter.remove_publication(
            str(DM_CHANNEL_ID), f"{DM_CHANNEL_ID}:{CARD_ID}"
        )

    assert "already gone" in caplog.text


async def test_a_webhook_that_is_not_there_is_not_a_card_that_is_gone() -> None:
    """Discord answers "Unknown Webhook" with the same 404 as "Unknown
    Message". Reading the first as the second retires a card that is still on
    the screen, and nothing later looks at the row again."""
    adapter, _channel, _thread, publication = _guild_setup()
    publication.delete_error = _unknown_webhook()

    with pytest.raises(RemovalFailed) as raised:
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert isinstance(raised.value.__cause__, discord.NotFound)


async def test_failing_to_find_the_webhook_is_owed_and_deletes_nothing() -> None:
    """Resolving the webhook is a step before the deletion. Whatever it
    answers is about the webhook, and the card was never asked about."""
    adapter, channel, _thread, publication = _guild_setup()
    channel.webhook_error = _unknown_webhook()

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert publication.deletes == []


async def test_a_card_the_webhook_did_not_send_is_still_in_the_channel() -> None:
    """The publication webhook is looked up by name and created when none is
    found, so one deleted in the channel's settings is replaced by a webhook
    that sent none of the cards already posted. It answers "Unknown Message"
    for every one of them while they sit there, so the channel is asked."""
    adapter, channel, _thread, publication = _guild_setup()
    publication.delete_error = _unknown_message()
    channel.messages[CARD_ID] = _Message(channel, CARD_ID)

    with pytest.raises(RemovalFailed) as raised:
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert "still in the channel" in str(raised.value)


async def test_a_card_that_cannot_be_read_back_is_owed_rather_than_gone() -> None:
    """The confirming read is the whole of the evidence. Without it there is
    nothing to record, so a read that fails leaves the removal owed."""
    adapter, channel, _thread, publication = _guild_setup()
    publication.delete_error = _unknown_message()
    channel.fetch_error = _http_error(503)

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(str(CHANNEL_ID), CARD)


async def test_a_throttled_read_back_is_a_wait_like_any_other() -> None:
    """The likeliest 429 on the whole path, because this route is only reached
    after the webhook route has already answered — and the one where losing the
    delay costs most, since the caller then backs off against a number Discord
    had already named."""
    adapter, channel, _thread, publication = _guild_setup()
    publication.delete_error = _unknown_message()
    channel.fetch_error = _http_error(429, headers={"Retry-After": "17"})

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert raised.value.retry_after == 17


async def test_being_asked_to_wait_is_kept_apart_from_being_refused() -> None:
    """A rate limit says nothing about the card, so it must not arrive as
    `RemovalFailed`: the caller's backoff would then double its own interval
    against a delay Discord had already named."""
    adapter, _channel, _thread, publication = _guild_setup()
    publication.delete_error = _http_error(429, headers={"Retry-After": "31"})

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert raised.value.retry_after == 31


async def test_a_rate_limit_the_library_raised_itself_also_waits() -> None:
    """discord.py reports a 429 two ways, and the one it raises before sending
    carries the delay as an attribute rather than a header."""
    adapter, _channel, _thread, publication = _guild_setup()
    publication.delete_error = discord.RateLimited(12.0)

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(str(CHANNEL_ID), CARD)

    assert raised.value.retry_after == 12.0


async def test_a_server_error_is_owed_rather_than_settled() -> None:
    """An uncertain send has to keep its reservation, because a second attempt
    would post a second card. A deletion has no such twin: asking again about
    one that did land is answered with "already gone", so the uncertain case
    joins the refusals and is simply owed."""
    adapter, _channel, _thread, publication = _guild_setup()
    publication.delete_error = _http_error(503)

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(str(CHANNEL_ID), CARD)


async def test_a_channel_that_cannot_be_resolved_is_not_a_card_that_is_gone() -> None:
    """Deciding where to send the deletion comes first, and failing there says
    nothing about the card. Reading it as success would retire a card still on
    the screen."""
    adapter, _channel, _thread, _publication = _guild_setup()
    adapter._connection._client.fetch_errors[CHANNEL_ID] = _unknown_message()  # type: ignore[union-attr]
    adapter._connection._client._channels.pop(CHANNEL_ID)  # type: ignore[union-attr]

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(str(CHANNEL_ID), CARD)


async def test_an_unparseable_reference_never_reaches_discord() -> None:
    """A reference that is not two snowflakes is refused before anything is
    asked of Discord — not partway through, once the channel has been
    resolved, by an `int()` that happens to raise."""
    adapter, channel, _thread, publication = _guild_setup()
    looked_up: list[int] = []
    client = adapter._connection._client
    client.get_channel = _recording(client.get_channel, looked_up)  # type: ignore[union-attr]

    for reference in ("nonsense", f"{CHANNEL_ID}:", ":999", "abc:def"):
        with pytest.raises(RemovalFailed):
            await adapter.remove_publication(str(CHANNEL_ID), reference)

    assert publication.deletes == []
    assert channel.deleted_ids == []
    assert looked_up == []


async def test_a_disconnected_adapter_does_not_claim_the_card_was_removed() -> None:
    """Nothing was asked of Discord, so nothing is known about the card."""
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(str(CHANNEL_ID), CARD)


def test_discord_is_a_platform_that_says_it_can_do_this() -> None:
    """The capability is what routes an answered card here at all."""
    assert DiscordAdapter.removes_answered_cards is True


def test_the_fakes_agree_on_which_webhook_is_which() -> None:
    """Guards the test above that asserts the agents' webhook was left alone:
    were both names to resolve to one fake, it would pass for the wrong
    reason."""
    agents: Any = _Webhook(_WEBHOOK_NAME)
    publications: Any = _Webhook(_PUBLICATION_WEBHOOK_NAME)

    assert agents.id != publications.id
