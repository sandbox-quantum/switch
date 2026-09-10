"""What comes back when someone answers a request.

Two ways in, and one rule for both. A press hands back the control's id and the
opaque token the bridge minted when it posted the message; a typed answer hands
back a handle and a number. That is all either is trusted for. The session, the
epoch and the revision an answer stands against are read from the record those
resolve to; the actor is the identity the bridge verified for itself. Nothing an
answer carries is taken from the payload that prompted it.

Both paths resolve what they were given against the form the card offered, kept
on the record when it was posted. It is what the person can see, so it is what
"1" means, and an answer against a card the session has moved past is refused
on revision rather than applied to whatever the request became. `form.py` owns
that resolution and both ends of it; this is where its refusals get logged.

Neither path returns only a command. `None` and `Refused` are different
answers, and the difference is whether anyone was trying to answer. Almost
everything said in a channel is not an answer, and a bridge that told people so
would be a bridge nobody could talk near a card; but an answer aimed at a card
that exists and then going nowhere in silence is indistinguishable from one
that worked. So: `None` where this decided the message was not an answer,
`Refused` where it took it as one and then could not complete it.

Which card the message was aimed at is therefore the line, and it is drawn at
the lookup rather than at the grammar. A press names its card in a token this
layer minted, so it is over that line from the start. A typed handle is not:
the grammar reads the first word of every message as a possible handle, so
`slice 8` reaches here shaped exactly like `R42 1`, and only finding the card
tells them apart.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from switch_core.bridges.collaboration.models import InboundInteraction, InboundMessage
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .contract import Command, Origin, RequestAnswer, RequestResult, Surface
from .form import (
    Unanswerable,
    resolve_pressed_option,
    resolve_text_answer,
    takes_a_bare_decision,
)
from .renderers import parse_answer_action
from .text import TextAnswer, parse_text_answer

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

# Fixed so that a command id is a function of what was decided rather than of
# when. Regenerating it must give the same answer on any host, in any process.
_COMMAND_NAMESPACE = uuid.UUID("6f5a2d18-9a1e-4f0b-9d3c-0a2f7c1b84e5")


def answer_command(
    post: SessionRequestPost, *, answer: RequestResult, origin: Origin
) -> Command:
    """The `request.answer` a resolved answer stands for.

    `expectedRevision` comes off the record rather than the callback, so an
    answer to a card that has since been superseded is rejected by the session
    instead of applied to whatever the request became.
    """
    return Command(
        contract_version=1,
        command_id=_command_id(post, answer=answer, actor_id=origin.actor_id),
        session_id=post.session_id,
        epoch=post.epoch,
        origin=origin,
        body=RequestAnswer(
            type="request.answer",
            request_id=post.request_id,
            expected_revision=post.revision,
            answer=answer,
        ),
    )


def _command_id(
    post: SessionRequestPost, *, answer: RequestResult, actor_id: str
) -> str:
    """Derived, so that one person answering twice the same way is one command.

    Two people answering differently stay two commands, and the session settles
    on whichever arrives first; the other is refused on its revision. The answer
    itself is serialised with its keys sorted so that the same choices give the
    same id whichever order they were typed in.
    """
    key = "|".join(
        [
            post.session_id,
            post.epoch,
            post.request_id,
            str(post.revision),
            json.dumps(
                answer.model_dump(by_alias=True),
                sort_keys=True,
                separators=(",", ":"),
            ),
            actor_id,
        ]
    )
    return str(uuid.uuid5(_COMMAND_NAMESPACE, key))


# The one refusal that is not about the card, and the only one both paths
# reach, so it is written once and reads the same either way.
_NO_IDENTITY = (
    "Switch does not know who this account belongs to, and an answer is only "
    "ever recorded against someone it can name"
)

# A reason can quote something the host chose the length of: an option id is
# `min_length=1` in the contract and has no maximum. Short, because this is one
# sentence in a channel and the whole of it is meant to be read at a glance.
_MAX_REASON = 300


@dataclass(frozen=True)
class Refused:
    """An answer that was aimed at a card and did not land.

    `reason` finishes the sentence "…, because", the same way `Unanswerable`'s
    does, because most of these are one: the wording that explains a refusal to
    whoever reads the log is the wording that explains it to whoever typed.
    `handle` names the card when it is known, so the person can be told which
    of several they were answering. `card_ref` is the card's own post — set
    whenever a card was found, which is every refusal past the lookup — so a
    notice can be said in the card's thread rather than wherever the answer
    happened to be typed, which may be nowhere at all.
    """

    reason: str
    handle: str | None
    card_ref: str | None = None

    def told(self) -> str:
        """What to say to the person who gave the answer.

        One sentence, and never an apology: they did something reasonable and
        it did not work, so the useful part is which card and why.
        """
        card = f" to {self.handle}" if self.handle else ""
        reason = self.reason
        if len(reason) > _MAX_REASON:
            reason = reason[: _MAX_REASON - 1].rstrip() + "…"
        return f"Your answer{card} did not land, because {reason}."


class InboundActor(Protocol):
    """As much of an inbound event as naming who sent it needs.

    A press and a typed answer arrive as different models, and the bridge names
    the person behind either one the same way.
    """

    channel_id: str
    sender_id: str
    sender_name: str


class SessionInteractions:
    """One bridge's inbound half: an answer, however it was given, as a command.

    `identify` is how the bridge names the person who acted. It is given the
    inbound event and returns the Switch identity behind the platform account,
    or None when there is not one — which is a refusal, not a default actor.

    `is_first_reply` is how it asks the platform whether a message is the first
    thing said under a card, which is the only place a bare "yes" is an answer.
    It is given the channel, the card and the message, and False is its answer
    whenever the platform cannot tell.
    """

    def __init__(
        self,
        *,
        bridge_id: str,
        surface: Surface,
        posts: SessionRequestPostStore,
        session_factory: async_sessionmaker[AsyncSession],
        identify: Callable[[InboundActor], Awaitable[str | None]],
        is_first_reply: Callable[[str, str, str], Awaitable[bool]],
    ) -> None:
        self._bridge_id = bridge_id
        self._surface = surface
        self._posts = posts
        self._session_factory = session_factory
        self._identify = identify
        self._is_first_reply = is_first_reply

    async def command_for(
        self, interaction: InboundInteraction
    ) -> Command | Refused | None:
        """The command a press amounts to, or why it amounts to none.

        Only a control this layer did not write is None here. Everything else
        is someone pressing a button we put in front of them, which is as clear
        an attempt to answer as there is.
        """
        option_id = parse_answer_action(interaction.action_id)
        if option_id is None:
            return None

        async with self._session_factory() as session:
            post = await self._posts.get_by_token(
                session, self._bridge_id, interaction.value
            )
        if post is None:
            logger.warning(
                "Ignoring an answer on bridge %s: its token resolves to no request. "
                "The card outlived its record, or the payload was not ours.",
                self._bridge_id,
            )
            return Refused(
                reason="this card is no longer connected to a live request",
                handle=None,
            )

        answer = resolve_pressed_option(post.form, option_id)
        if isinstance(answer, Unanswerable):
            logger.warning(
                "Ignoring a press on request %s on bridge %s, because %s.",
                post.request_id,
                self._bridge_id,
                answer.reason,
            )
            return Refused(
                reason=answer.reason, handle=post.handle, card_ref=post.external_post_id
            )

        actor_id = await self._identify(interaction)
        if actor_id is None:
            logger.warning(
                "Ignoring an answer to request %s: no Switch identity for %s on "
                "bridge %s. An answer is only ever attributed to a verified actor.",
                post.request_id,
                interaction.sender_id,
                self._bridge_id,
            )
            return Refused(
                reason=_NO_IDENTITY, handle=post.handle, card_ref=post.external_post_id
            )

        origin = Origin(
            surface=self._surface,
            actor_id=actor_id,
            room_id=post.room_id,
            thread_id=post.thread_id,
            message_id=interaction.message_ref,
        )
        return answer_command(post, answer=answer, origin=origin)

    async def command_for_text(
        self, message: InboundMessage
    ) -> Command | Refused | None:
        """The command a typed answer amounts to, or why it amounts to none.

        Almost everything said in a channel is not an answer, so None is the
        ordinary outcome and not a failure. What is refused rather than ignored
        is an answer that named a card and then did not fit it — a number the
        card has no option at, or a word that fits more than one.
        """
        answer = parse_text_answer(message.content)
        if answer is None:
            return None

        if message.sender_is_app:
            # Asked before the card is found rather than after: an app cannot
            # answer whichever card it named, so a refusal here would be one
            # aimed at nobody who can read it.
            logger.warning(
                "Ignoring an answer in %s on bridge %s: it was posted by an "
                "app, and a decision is attributed to whoever made it. No "
                "button press can come from an app either.",
                message.channel_id,
                self._bridge_id,
            )
            return None

        post = await self._post_for(message, answer)
        if post is None:
            return None

        resolved = resolve_text_answer(post.form, answer)
        if isinstance(resolved, Unanswerable):
            logger.warning(
                "Ignoring an answer to request %s on bridge %s, because %s.",
                post.request_id,
                self._bridge_id,
                resolved.reason,
            )
            return Refused(
                reason=resolved.reason,
                handle=post.handle,
                card_ref=post.external_post_id,
            )

        actor_id = await self._identify(message)
        if actor_id is None:
            logger.warning(
                "Ignoring an answer to request %s: no Switch identity for %s on "
                "bridge %s. An answer is only ever attributed to a verified actor.",
                post.request_id,
                message.sender_id,
                self._bridge_id,
            )
            return Refused(
                reason=_NO_IDENTITY, handle=post.handle, card_ref=post.external_post_id
            )

        origin = Origin(
            surface=self._surface,
            actor_id=actor_id,
            room_id=post.room_id,
            thread_id=post.thread_id,
            message_id=message.message_ref,
        )
        return answer_command(post, answer=resolved, origin=origin)

    async def _post_for(
        self, message: InboundMessage, answer: TextAnswer
    ) -> SessionRequestPost | None:
        """The card an answer is against: the one it named, or the one it replies to.

        A bare decision names nothing, so it only counts as a direct reply to a
        card, and only as the first one. Anywhere else — including further down
        a thread that has become a conversation — it is someone agreeing with
        someone. Naming the request lifts that: a handle says which card, so it
        answers from anywhere in the channel however long afterwards.

        Nobody is told when the message named no card that exists. A handle is
        whatever token the message started with, so `slice 8` and `python 3`
        parse exactly like `R42 1` and only the lookup can tell them apart —
        which makes a handle matching nothing overwhelmingly ordinary chatter
        rather than a misdirected answer. Everything this returns `None` for is
        this layer concluding the message was not an answer at all. The
        refusals that do reach someone are the ones after a card was found.
        """
        async with self._session_factory() as session:
            if answer.handle is not None:
                named = await self._posts.get_by_handle(
                    session, self._bridge_id, message.channel_id, answer.handle
                )
                if named is None:
                    logger.debug(
                        "Not an answer on bridge %s: nothing in channel %s is "
                        "called %s.",
                        self._bridge_id,
                        message.channel_id,
                        answer.handle,
                    )
                    return None
                return named
            if message.root_id is None:
                return None
            post = await self._posts.get_by_post(
                session, self._bridge_id, message.root_id
            )
        if post is None:
            return None
        if not takes_a_bare_decision(post.form):
            # Refused here rather than after resolving, because working out
            # whether this was the first reply is a call to the platform and a
            # card that asks questions has no decision for a word to name.
            # Which is also why nobody is told: without that call this cannot
            # tell someone answering the card from someone agreeing in its
            # thread, and only the first of those wants to hear about it.
            logger.warning(
                "Ignoring a bare answer to request %s on bridge %s: that card asks "
                "questions rather than for a decision. Answering %s by name says "
                "which question.",
                post.request_id,
                self._bridge_id,
                post.handle,
            )
            return None
        if not await self._is_first_reply(
            message.channel_id, message.root_id, message.message_ref
        ):
            logger.warning(
                "Ignoring a bare answer to request %s on bridge %s: it is not "
                "the first reply to the card, or the platform could not say. "
                "Answering %s by name works from anywhere.",
                post.request_id,
                self._bridge_id,
                post.handle,
            )
            return None
        return post
