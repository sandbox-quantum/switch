"""Taking a Mattermost card back, and being able to say whether it worked.

The bridge connects as a system admin, so it may delete a post written by an
agent's bot — which every card is, and the reference does not say whose.

Answering a request no longer removes its card: Mattermost is the one platform
that leaves a "(message deleted)" line behind a post taken down while a reader
has the channel open, and a card edited down to its outcome reads better than
that placeholder. So `removes_answered_cards` is off and nothing in the
publication loop reaches the seam below. It is kept, and kept honest here,
because the flag is the whole of the decision and the seam is what a reversal
would need — the port's default raises rather than pretending.

The half that has always mattered is that a caller acting on the result —
writing down that a card is gone — must not be told success where none was
established. That is why this is not `delete_message`, which logs and returns
either way.
"""

from __future__ import annotations

import logging

import pytest
from mattermostdriver.exceptions import NotEnoughPermissions, ResourceNotFound

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)

from .test_mattermost_sdk_only import _adapter, _http_error, _posts

CARD = "post-card"
CHANNEL = "chan-1"


async def test_a_card_is_taken_back_as_the_account_that_may_delete_it() -> None:
    """The card was posted by an agent's bot and the reference does not say
    which. The admin is the account that may delete a post it did not write."""
    adapter = _adapter("worker")

    await adapter.remove_publication(CHANNEL, CARD)

    assert _posts(adapter).deleted == [CARD]
    assert _posts(adapter).deleted_by == ["admin"]


async def test_a_refusal_is_raised_rather_than_logged() -> None:
    """The caller records that the card is gone. A refusal it never hears about
    is a record saying a card in the channel is not there, and the publisher
    then stops redrawing a card that still offers buttons."""
    adapter = _adapter()
    _posts(adapter).delete_error = NotEnoughPermissions("403")

    with pytest.raises(RemovalFailed) as raised:
        await adapter.remove_publication(CHANNEL, CARD)

    assert isinstance(raised.value.__cause__, NotEnoughPermissions)


async def test_a_card_already_gone_is_reported_as_gone_but_said_out_loud(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing remains at the address, which is what the caller asked for, so
    this is not a failure — and it is how a deletion whose acknowledgement was
    lost settles itself on the next attempt."""
    adapter = _adapter()
    _posts(adapter).delete_error = ResourceNotFound("404")

    with caplog.at_level(logging.WARNING):
        await adapter.remove_publication(CHANNEL, CARD)

    assert "already gone" in caplog.text


async def test_being_asked_to_wait_is_kept_apart_from_being_refused() -> None:
    """A rate limit says nothing about the card, so it must not arrive as
    `RemovalFailed`: the caller's backoff would then double its own interval
    against a delay Mattermost had already named."""
    adapter = _adapter()
    _posts(adapter).delete_error = _http_error(429, **{"Retry-After": "17"})

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(CHANNEL, CARD)

    assert raised.value.retry_after == 17


async def test_a_rate_limit_that_names_no_interval_still_names_a_wait() -> None:
    """Mattermost is not obliged to send `Retry-After`, and a wait of zero is
    an immediate second attempt into the same limit."""
    adapter = _adapter()
    _posts(adapter).delete_error = _http_error(429)

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.remove_publication(CHANNEL, CARD)

    assert raised.value.retry_after > 0


async def test_a_server_error_is_owed_rather_than_settled() -> None:
    """An uncertain send has to keep its reservation, because a second attempt
    would post a second card. A deletion has no such twin: asking again about
    one that did land is answered with "not found", so the uncertain case joins
    the refusals and is simply owed."""
    adapter = _adapter()
    _posts(adapter).delete_error = _http_error(503)

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARD)


async def test_a_request_that_never_came_back_is_owed_too() -> None:
    """The same reading as a server error: nothing is known, so nothing may be
    recorded, and the card is asked about again."""
    adapter = _adapter()
    _posts(adapter).delete_error = TimeoutError("response lost")

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARD)


async def test_a_blank_reference_never_reaches_mattermost() -> None:
    """An empty id is a DELETE against the posts collection rather than
    against a post, and a 404 from one of those would be read as a card that
    had already gone."""
    adapter = _adapter()

    for reference in ("", "   "):
        with pytest.raises(RemovalFailed):
            await adapter.remove_publication(CHANNEL, reference)

    assert _posts(adapter).deleted == []


async def test_a_disconnected_adapter_does_not_claim_the_card_was_removed() -> None:
    """Nothing was asked of Mattermost, so nothing is known about the card."""
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )

    with pytest.raises(RemovalFailed):
        await adapter.remove_publication(CHANNEL, CARD)


def test_an_answered_mattermost_card_is_not_taken_back() -> None:
    """The capability is what routes an answered card into removal at all, and
    Mattermost declines it: a deleted post leaves a "(message deleted)" line
    for anyone with the channel open, and a card edited down to its outcome
    says more than that tombstone does. The machinery above reads this flag, so
    turning it off is the whole of what keeps an answered card on the screen.
    """
    assert MattermostAdapter.removes_answered_cards is False
