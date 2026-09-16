"""A permission card after somebody has answered it.

An answered card has nothing left to ask, whichever way it was answered, and
on a platform that can prove it took the message back it is removed rather
than left as a settled notice. What stays is a card nobody has answered:
unanswered, still being submitted, ended without an answer at all, or
cancelled — which stops the operation rather than deciding it.

The row outlives the card, because it is what a handle typed into the channel
still resolves to, and because without it a restarted publisher would read the
request as one whose card had never been drawn. The decision itself is in the
session and in Console; the channel is not where it is kept.

`test_publication.py` covers the same path up to settlement; this is what
happens after it.
"""

from __future__ import annotations

import asyncio
import logging

import pytest
from sqlalchemy import select

from switch_core.bridges.collaboration.adapter import (
    RemovalFailed,
    RichContentFailed,
    RichContentThrottled,
)
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.inbound import SessionInteractions
from switch_core.bridges.collaboration.session.outbound import SessionRequestCards
from switch_core.bridges.collaboration.session.renderers import ANSWER_ACTION
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore
from switch_core.sessions.publication import PublicationIncomplete, refresh_cards

from .test_authority import host_event, opened, setup
from .test_publication import Platform


class Removing(Platform):
    """A platform that can take a card back, and remembers being asked to.

    `lose_response` models the gap a deletion cannot avoid: the message goes,
    and the answer saying so does not arrive. The attempt after it returns
    normally, which is what the Slack adapter does when it asks about an
    address the platform no longer knows — the deletion is confirmed by its
    own absence rather than by the reply that went missing.

    Once the message is gone, editing it is refused. A fake that kept
    accepting edits let the deleted card be drawn as though it were still
    there, which is the one thing no real platform does.
    """

    removes_answered_cards = True

    def __init__(self) -> None:
        super().__init__()
        self.removed: list[tuple[str, str]] = []
        self.refuse: str | None = None
        self.throttle: float | None = None
        self.lose_response = False
        self.gone = False

    async def remove_publication(self, channel: str, message_ref: str) -> None:
        self.removed.append((channel, message_ref))
        if self.throttle is not None:
            raise RichContentThrottled(
                retry_after=self.throttle, text="Waiting for the platform."
            )
        if self.refuse is not None:
            raise RemovalFailed(self.refuse)
        self.gone = True
        if self.lose_response:
            self.lose_response = False
            raise TimeoutError("the delete was accepted; the reply never came")

    async def update_rich(self, channel, agent, post, content, thread):
        if self.gone:
            raise RichContentFailed(f"No message at {post}.", text="Allow once.")
        await super().update_rich(channel, agent, post, content, thread)


def _guards() -> dict[str, object]:
    """The real redraw pair, so a cycle that changes nothing draws nothing."""
    seen: dict[str, tuple[int, str]] = {}
    return {
        "refresh_needed": lambda token, state: seen.get(token) != state,
        "refreshed": lambda token, state: seen.__setitem__(token, state),
    }


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


async def test_an_answered_card_is_taken_away_rather_than_drawn_settled(
    session_factory,
):
    """Asked for first, drawn only if the platform still has it.

    The settled draw is the fallback for a removal that did not happen, not a
    step on the way to one: editing a card into its final state and deleting
    it in the same breath shows a reader nothing, and on the cycle after a
    deletion whose reply was lost it is an edit to a message that is not
    there — which fails, says so in the channel, and stops the deletion ever
    being confirmed.
    """
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    drawn = len(platform.edits)
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert platform.removed == [("channel-demo", post.external_post_id)]
    assert len(platform.edits) == drawn
    assert await _removed_at(session_factory) is not None


async def test_a_refusal_is_taken_away_too(session_factory):
    """A card answered no is as finished as one answered yes.

    The refusal is not lost with it: the request, its decision and who made it
    are in the session and in Console, and the row the handle resolves to
    stays. What goes is a message in a channel still showing buttons for a
    question that has been settled.
    """
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "deny")
    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert platform.removed == [("channel-demo", post.external_post_id)]
    assert await _removed_at(session_factory) is not None


async def test_a_card_nobody_has_answered_is_left_alone(session_factory):
    """The line the removal stands on: a decision, not a settlement.

    A request can end without anyone deciding it — it expires, the agent
    withdraws it, the host reports an error — and the card is then the only
    thing in the channel that says a question was asked at all.
    """
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await refresh_cards(session_factory, "bridge", "session-demo", cards)

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


async def test_a_refused_removal_leaves_the_settled_card_and_stays_owed(
    session_factory, caplog
):
    """A platform that will not delete is the case the mark must not appear.

    Written, the row would claim a card a reader can plainly see is gone, and
    the publisher would stop maintaining it. Absent, the card is exactly what
    a platform without the capability would have left — settled, answering
    nothing — and the refusal is in the log rather than in the channel.

    The cycle is also reported incomplete, which is the whole of what makes
    the next one happen: `SessionPublisher` records a session as published
    only when its cards came back clean.
    """
    platform = Removing()
    platform.refuse = "cant_delete_message"
    service, epoch, posts, cards, post = await _card(session_factory, platform)

    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    with caplog.at_level(logging.WARNING):
        with pytest.raises(PublicationIncomplete) as incomplete:
            await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert incomplete.value.backed_off == 1
    assert "Allow once" in platform.edits[-1][2]
    assert await _removed_at(session_factory) is None
    assert "cant_delete_message" in caplog.text


async def test_a_cancelled_removal_records_nothing(session_factory):
    """The mark cannot be laid down in advance of the fact it records.

    A publisher cancelled mid-cycle — a shutdown, a lease lost — must not
    leave behind a row saying a visible card is gone. Nothing would ever look
    at that row again, so the card would keep its decision on screen forever
    while the record said it had been taken away.
    """

    class Cancelling(Removing):
        async def remove_publication(self, channel: str, message_ref: str) -> None:
            raise asyncio.CancelledError()

    platform = Cancelling()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")

    with pytest.raises(asyncio.CancelledError):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert await _removed_at(session_factory) is None


async def test_a_deletion_whose_reply_was_lost_is_settled_by_asking_again(
    session_factory,
):
    """The other half of recording nothing in advance: recording late.

    The card goes and the acknowledgement does not arrive, so the row still
    says a removal is owed. Asking a second time is what closes it — the
    platform reports nothing at the address, which is the same fact as having
    just deleted it, and the record finally catches up.
    """
    platform = Removing()
    platform.lose_response = True
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")

    with pytest.raises(TimeoutError):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)
    assert await _removed_at(session_factory) is None

    await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert len(platform.removed) == 2
    assert await _removed_at(session_factory) is not None


async def test_a_restart_confirms_a_deletion_the_process_never_wrote_down(
    session_factory,
):
    """The same gap, across the restart that makes it permanent.

    A new process has no memory of what it drew, so every card reads as one
    due a redraw. The card here is not there to redraw: the edit fails, the
    "could not be updated" notice goes into the channel the card was taken out
    of, and the failure is raised before anything asks the platform whether the
    message is still at that address. Every later restart repeats the notice,
    and the row goes on owing a deletion that already happened. Asking first
    ends it instead: the platform reports nothing there, which is the removal
    confirmed, and the channel is told nothing it would have to unlearn.
    """

    class Talking(Removing):
        """Says out loud when a failed redraw falls back to a reply."""

        def __init__(self) -> None:
            super().__init__()
            self.notices: list[str] = []

        def notice_address(self, message_ref: str, thread: str | None) -> str:
            return thread or message_ref

        async def admin_message(self, channel, text, address, *, drawn):
            self.notices.append(text)
            return f"{channel}:notice"

    platform = Talking()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    platform.lose_response = True
    with pytest.raises(TimeoutError):
        await refresh_cards(
            session_factory, "bridge", "session-demo", cards, **_guards()
        )
    assert await _removed_at(session_factory) is None

    restarted = SessionRequestCards(
        platform,
        bridge_id="bridge",
        surface="slack",
        posts=posts,
        session_factory=session_factory,
    )
    await refresh_cards(
        session_factory, "bridge", "session-demo", restarted, **_guards()
    )

    assert len(platform.removed) == 2
    assert platform.notices == []
    assert len(platform.posts) == 1
    assert await _removed_at(session_factory) is not None


async def test_a_rate_limited_removal_carries_the_wait_the_platform_asked_for(
    session_factory,
):
    """Being told to wait is not being told no.

    A throttle has to reach the backoff as the platform's own delay, or the
    generic doubling would either hammer a busy channel or sit out a wait far
    longer than the one asked for. Nothing about the card is recorded either
    way: the deletion is still owed.
    """
    platform = Removing()
    platform.throttle = 27.0
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    delays: list[tuple[str, float]] = []

    with pytest.raises(PublicationIncomplete):
        await refresh_cards(
            session_factory,
            "bridge",
            "session-demo",
            cards,
            removal_delayed=lambda token, seconds: delays.append((token, seconds)),
        )

    assert delays == [(post.token, 27.0)]
    assert await _removed_at(session_factory) is None


async def test_a_transient_refusal_is_retried_without_another_redraw(session_factory):
    """Cleanup is owed by the record, not by anything having changed.

    This is the failure that hanging removal off the redraw produced: the
    second cycle sees a card at the same revision and state, draws nothing —
    correctly — and under the old shape skipped the deletion with it, for the
    life of the process. The card has to be tried again anyway.
    """
    platform = Removing()
    platform.refuse = "ratelimited"
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    guards = _guards()

    with pytest.raises(PublicationIncomplete):
        await refresh_cards(session_factory, "bridge", "session-demo", cards, **guards)
    drawn = len(platform.edits)
    platform.refuse = None
    await refresh_cards(session_factory, "bridge", "session-demo", cards, **guards)

    assert len(platform.edits) == drawn
    assert len(platform.removed) == 2
    assert await _removed_at(session_factory) is not None


async def test_a_card_recovered_after_it_was_answered_is_taken_back(session_factory):
    """Answered in Console while the send was still unconfirmed.

    Recovery binds the reservation to the message it finds and draws it
    settled, and that is the only cycle in which anything about the card
    changes. A removal reachable only from the redraw branch never ran here at
    all, and no later cycle went near it.
    """

    class Recovering(Removing):
        recovers_uncertain_posts = True

        def __init__(self) -> None:
            super().__init__()
            self.found = ""

        async def find_request_card(self, channel, thread, token, since, handle):
            return self.found

    platform = Recovering()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")
    platform.found = post.external_post_id
    async with session_factory() as db:
        stored = await db.get(SessionRequestPost, post.id)
        stored.external_post_id = stored.token
        await db.commit()
    guards = _guards()

    await refresh_cards(session_factory, "bridge", "session-demo", cards, **guards)
    await refresh_cards(session_factory, "bridge", "session-demo", cards, **guards)

    assert platform.removed == [("channel-demo", post.external_post_id)]
    assert await _removed_at(session_factory) is not None


async def test_a_card_found_again_is_drawn_whatever_the_gate_remembers(
    session_factory,
):
    """Recovery ends in a draw, and the redraw gate cannot say otherwise.

    The gate was told about the post whose delivery then went unconfirmed, so
    at the same revision and state it reads the found message as a card
    already drawn. It is not: it is a message matched by its handle, and
    drawing it once is what makes what the channel shows and what the record
    says agree. Sharing the settled card's gate would skip that on exactly the
    cycle nothing else had changed.
    """

    class Recovering(Removing):
        recovers_uncertain_posts = True

        def __init__(self) -> None:
            super().__init__()
            self.found = ""

        async def find_request_card(self, channel, thread, token, since, handle):
            return self.found

    platform = Recovering()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    platform.found = post.external_post_id
    guards = _guards()
    await refresh_cards(session_factory, "bridge", "session-demo", cards, **guards)
    drawn = len(platform.edits)
    async with session_factory() as db:
        stored = await db.get(SessionRequestPost, post.id)
        stored.external_post_id = stored.token
        await db.commit()

    await refresh_cards(session_factory, "bridge", "session-demo", cards, **guards)

    assert len(platform.edits) == drawn + 1


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
    """The counterweight to retrying a failure: a removal that succeeded is
    finished. Every cycle reaches every row, and the recorded mark is the only
    thing standing between that and deleting the same address once a cycle for
    as long as the session lives — by then an address Slack may have given to
    somebody else's message."""
    platform = Removing()
    service, epoch, posts, cards, post = await _card(session_factory, platform)
    await _answer(service, epoch, posts, post, session_factory, "allow-once")

    for _ in range(calls):
        await refresh_cards(session_factory, "bridge", "session-demo", cards)

    assert len(platform.removed) == 1
