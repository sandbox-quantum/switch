"""A permission card after the permission has been given.

A card that has been answered yes has nothing left to ask, and on a platform
that can prove it took the message back it is removed rather than left as a
settled notice. A refusal is not removed: it is the only durable record in the
channel that someone said no.

The row outlives the card either way, because it is what a handle typed into
the channel still resolves to, and because without it a restarted publisher
would read the request as one whose card had never been drawn.

`test_publication.py` covers the same path up to settlement; this is what
happens after it.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import select

from switch_core.bridges.collaboration.adapter import RemovalFailed
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.inbound import SessionInteractions
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.publication import refresh_cards

from .test_authority import host_event, opened, setup
from .test_publication import Platform


class Removing(Platform):
    """A platform that can take a card back, and remembers being asked to."""

    removes_approved_cards = True

    def __init__(self) -> None:
        super().__init__()
        self.removed: list[tuple[str, str]] = []
        self.refuse: str | None = None

    async def remove_publication(self, channel: str, message_ref: str) -> None:
        self.removed.append((channel, message_ref))
        if self.refuse is not None:
            raise RemovalFailed(self.refuse)


async def _card(session_factory, platform):
    """Open a request, post its card, and hand back everything to answer it."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    posts = SessionRequestPostStore()
    cards = SessionRequestCards(
        platform,
        bridge_id="bridge",
        surface="slack",
        posts=posts,
        session_factory=session_factory,
    )
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    async with session_factory() as db:
        post = await db.scalar(select(SessionRequestPost))
        db.expunge(post)
    return service, epoch, posts, cards, post


async def _answer(service, epoch, posts, post, session_factory, option_id):
    """Press an option and have the host confirm it, as a real settlement."""

    async def identify(interaction):
        return "@owner:example.test"

    async def first_reply(channel, root, message):
        return False

    interactions = SessionInteractions(
        bridge_id="bridge",
        surface="slack",
        posts=posts,
        session_factory=session_factory,
        identify=identify,
        is_first_reply=first_reply,
    )
    command = await interactions.command_for(
        InboundInteraction(
            channel_id="channel-demo",
            sender_id="platform-owner",
            sender_name="Owner",
            action_id=f"{ANSWER_ACTION}:{option_id}",
            value=post.token,
            message_ref=post.external_post_id,
        )
    )
    assert command is not None
    await service.submit(command, user_id=None, bridge_id="bridge")
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "request.settled",
                "requestId": command.body.request_id,
                "revision": 2,
                "outcome": "answered",
                "commandId": command.command_id,
                "result": command.body.answer.model_dump(by_alias=True),
            },
        ),
    )


async def _removed_at(session_factory):
    async with session_factory() as db:
        return (await db.scalar(select(SessionRequestPost))).removed_at


async def test_a_granted_card_is_drawn_settled_and_then_taken_away(session_factory):
    """Settled first, removed second, and not the other way round.

    The redraw is what a refused removal falls back to, so the card has to be
    made to say what was decided before anything tries to delete it — and if
    the process stops in between, what is left behind is an honest card.
    """
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert "Allow once" in platform.edits[-1][2]
    assert platform.removed == [("channel-demo", post.external_post_id)]
    assert await _removed_at(session_factory) is not None


async def test_a_refusal_keeps_its_card(session_factory):
    """The channel's only record that permission was asked for and withheld.
    Deleting it would leave the audit holding the one copy of that."""
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "deny")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert "Deny" in platform.edits[-1][2]
    assert platform.removed == []
    assert await _removed_at(session_factory) is None


async def test_a_platform_that_cannot_prove_a_removal_is_not_asked_to_try(
    session_factory,
):
    """The four platforms still to come. Their cards settle exactly as they
    did before, which is the behaviour a checkpoint at a time has to preserve.
    """
    platform = Platform()
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert "Allow once" in platform.edits[-1][2]
    assert await _removed_at(session_factory) is None


async def test_a_card_already_taken_away_is_not_drawn_again(session_factory):
    """What stops a restart reposting a question already answered.

    The publisher reaches every row it has for as long as the session is
    around, and nothing else in the row distinguishes a card that was removed
    from one that merely needs bringing up to date. Editing a deleted message
    fails, and that failure posts "this card could not be updated" into the
    channel the card was just taken out of.
    """
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    drawn = len(platform.edits)

    await refresh_cards(session_factory, "bridge", "session-demo", cards)
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert len(platform.edits) == drawn
    assert len(platform.posts) == 1
    assert len(platform.removed) == 1


async def test_a_refused_removal_leaves_the_settled_card_and_says_nothing_more(
    session_factory, caplog
):
    """A platform that will not delete is the case the mark must not survive.

    Left set, the row would claim a card a reader can plainly see is gone, and
    the publisher would stop maintaining it. Cleared, the card is exactly what
    a platform without the capability would have left — settled, answering
    nothing — and the refusal is in the log rather than in the channel.
    """
    platform = Removing()
    platform.refuse = "cant_delete_message"
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    with caplog.at_level(logging.WARNING):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert "Allow once" in platform.edits[-1][2]
    assert await _removed_at(session_factory) is None
    assert "cant_delete_message" in caplog.text


async def test_a_removed_card_still_answers_to_its_handle(session_factory):
    """The row is not the card. Someone who typed the handle before the card
    went, or who is reading the audit, still resolves to the same request —
    and the session, not this, is what refuses an answer already given.
    """
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    async with session_factory() as db:
        found = await posts.get_by_handle(db, "bridge", "channel-demo", post.handle)

    assert found is not None
    assert found.request_id == post.request_id


@pytest.mark.parametrize("calls", [1, 2, 3])
async def test_removal_is_attempted_once_however_often_the_publisher_runs(
    session_factory, calls
):
    """Every cycle reaches every row, and a second delete of the same message
    is a second chance to act on `message_not_found` from an address that has
    since been reused."""
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")

    for _ in range(calls):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert len(platform.removed) == 1
