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
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
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

    async def command_for(self, interaction: InboundInteraction) -> Command | None:
        """The command an interaction amounts to, or None if it amounts to none.

        None covers a control this layer did not write, a token that names no
        request here, and an actor the bridge cannot put a Switch identity to.
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
            return None

        if (
            interaction.channel_id != post.external_channel_id
            or interaction.message_ref != post.external_post_id
        ):
            logger.warning(
                "Refusing an answer whose channel or message differs from the request card."
            )
            return None

        answer = resolve_pressed_option(post.form, option_id)
        if isinstance(answer, Unanswerable):
            logger.warning(
                "Ignoring a press on request %s on bridge %s, because %s.",
                post.request_id,
                self._bridge_id,
                answer.reason,
            )
            return None

        actor_id = await self._identify(interaction)
        if actor_id is None:
            logger.warning(
                "Ignoring an answer to request %s: no Switch identity for %s on "
                "bridge %s. An answer is only ever attributed to a verified actor.",
                post.request_id,
                interaction.sender_id,
                self._bridge_id,
            )
            return None

        origin = Origin(
            surface=self._surface,
            actor_id=actor_id,
            room_id=post.room_id,
            thread_id=post.thread_id,
            message_id=interaction.message_ref,
        )
        return answer_command(post, answer=answer, origin=origin)

    async def command_for_text(self, message: InboundMessage) -> Command | None:
        """The command a typed answer amounts to, or None if it is not one.

        Almost everything said in a channel is not an answer, so None is the
        ordinary outcome and not a failure. What is refused rather than ignored
        is an answer that named a card and then did not fit it — a number the
        card has no option at, or a word that fits more than one.
        """
        answer = parse_text_answer(message.content)
        if answer is None:
            return None

        post = await self._post_for(message, answer)
        if post is None:
            return None

        if post.external_post_id == post.token:
            logger.warning(
                "Refusing a typed answer to unconfirmed card %s on bridge %s.",
                post.handle,
                self._bridge_id,
            )
            return None

        if message.sender_is_app:
            logger.warning(
                "Ignoring an answer to request %s on bridge %s: it was posted by "
                "an app, and a decision is attributed to whoever made it. No "
                "button press can come from an app either.",
                post.request_id,
                self._bridge_id,
            )
            return None

        resolved = resolve_text_answer(post.form, answer)
        if isinstance(resolved, Unanswerable):
            logger.warning(
                "Ignoring an answer to request %s on bridge %s, because %s.",
                post.request_id,
                self._bridge_id,
                resolved.reason,
            )
            return None

        actor_id = await self._identify(message)
        if actor_id is None:
            logger.warning(
                "Ignoring an answer to request %s: no Switch identity for %s on "
                "bridge %s. An answer is only ever attributed to a verified actor.",
                post.request_id,
                message.sender_id,
                self._bridge_id,
            )
            return None

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
        """
        async with self._session_factory() as session:
            if answer.handle is not None:
                return await self._posts.get_by_handle(
                    session, self._bridge_id, message.channel_id, answer.handle
                )
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
