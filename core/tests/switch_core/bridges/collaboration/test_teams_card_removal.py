"""Taking a Teams card back, and being able to say whether it worked.

A bot deletes its own activities through the Bot Connector, which is how every
card was posted. The address is the interesting part: it is the one Teams
confirmed and the caller wrote down, not one this process rebuilds — and where
it does have to rebuild one, a 404 is as likely to be the address as the card.

The other half is that a caller acting on the result — writing down that a card
is gone — must not be told success where none was established. That is why this
is not `delete_message`, which addresses the message through a map a restart
empties.
"""

from __future__ import annotations

import logging

import pytest

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    _publication_ref,
)
from switch_core.bridges.collaboration.teams.connector import (
    BotConnectorConflict,
    BotConnectorGone,
    BotConnectorRefused,
    BotConnectorThrottled,
    BotConnectorUnavailable,
)

from .test_teams_adapter import _adapter
from .test_teams_sdk_only import CHANNEL, ROOT, SERVICE_URL, _restart, _teams

CONVERSATION = f"{CHANNEL};messageid={ROOT}"
CARD = "card-1"
# What `post_rich` handed back and the caller stored: the service that holds
# the conversation, the conversation, and the activity inside it.
CARRIED = _publication_ref(SERVICE_URL, CONVERSATION, CARD)


async def test_a_card_is_taken_back_at_the_address_teams_confirmed() -> None:
    """All three parts come out of the reference rather than being worked out
    again, which is what makes this survive a restart, a regional service URL
    and a conversation Teams named itself."""
    adapter, connector = _teams()
    _restart(adapter)

    await adapter.remove_publication(CHANNEL, CARRIED)

    assert connector.deletes == [
        {
            "conversation_id": CONVERSATION,
            "activity_id": CARD,
            "service_url": SERVICE_URL,
        }
    ]


async def test_a_refusal_is_raised_rather_than_logged() -> None:
    """The caller records that the card is gone. A refusal it never hears about
    is a record saying a card in the post is not there, and the publisher then
    stops redrawing a card that still offers buttons."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorRefused("no", status=403, retry_after=None)

    with pytest.raises(RemovalFailed) as raised:
        await adapter.remove_publication(CHANNEL, CARRIED)

    assert isinstance(raised.value.__cause__, BotConnectorRefused)


async def test_a_card_already_gone_from_a_known_address_is_gone(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Teams issued the address, so nothing remains at it — which is what the
    caller asked for, and how a deletion whose acknowledgement was lost settles
    itself on the next attempt."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorGone("gone", status=404, retry_after=None)

    with caplog.at_level(logging.WARNING):
        await adapter.remove_publication(CHANNEL, CARRIED)

    assert "already gone" in caplog.text


async def test_nothing_at_a_rebuilt_address_is_not_a_card_that_is_gone() -> None:
    """A bare message id has no address of its own, so one is guessed from the
    channel. A 404 against a guess says the guess may be wrong, and an outcome
    that cannot be told apart from a bad address must not retire the card."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorGone("gone", status=404, retry_after=None)

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, "MSG1")


async def test_being_asked_to_wait_is_kept_apart_from_being_refused() -> None:
    """A rate limit says nothing about the card, so it must not arrive as
    `RemovalFailed`: the caller's backoff would then double its own interval
    against a delay Teams had already named."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorThrottled(
        "slow down", status=429, retry_after=12.0
    )

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(CHANNEL, CARRIED)

    assert raised.value.retry_after == 12.0


async def test_a_wait_teams_put_no_number_on_is_owed_rather_than_invented() -> None:
    """The caller takes a named wait as authoritative and drops its own
    interval for it, so a number this side made up is not a smaller lie than a
    wrong one: five seconds substituted every sweep holds the cleanup at its
    floor while Teams is refusing everything."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorThrottled(
        "slow down", status=429, retry_after=None
    )

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARRIED)


async def test_something_else_writing_first_is_owed_rather_than_waited_out() -> None:
    """A 412 is contention over a dependency, and Teams names no interval with
    it. A second of invented backoff would come back shorter than the interval
    the cleanup had already grown to, and reset the growth each time round, so
    a channel conflicting persistently would be retried hardest."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorConflict("busy", status=412, retry_after=None)

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARRIED)


async def test_a_request_that_never_came_back_is_owed_rather_than_settled() -> None:
    """An uncertain send has to keep its reservation, because a second attempt
    would post a second card. A deletion has no such twin: asking again about
    one that did land is answered with a 404 at an address Teams issued, so the
    uncertain case joins the refusals and is simply owed."""
    adapter, connector = _teams()
    connector.fail_delete = BotConnectorUnavailable(
        "timeout", status=None, retry_after=None
    )

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARRIED)


async def test_a_disconnected_adapter_does_not_claim_the_card_was_removed() -> None:
    """Nothing was asked of Teams, so nothing is known about the card."""
    adapter = _adapter()

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARRIED)


async def test_a_card_in_a_chat_is_taken_back_from_the_chat_itself() -> None:
    """A chat is its own conversation, and it is the layout that deletes
    cleanly rather than leaving a tombstone."""
    adapter, connector = _teams(chat=True)
    chat_card = _publication_ref(SERVICE_URL, "a:1chat", CARD)

    await adapter.remove_publication("a:1chat", chat_card)

    assert connector.deletes[0]["conversation_id"] == "a:1chat"


def test_teams_is_a_platform_that_says_it_can_do_this() -> None:
    """The capability is what routes an answered card here at all."""
    assert TeamsAdapter.removes_answered_cards is True
