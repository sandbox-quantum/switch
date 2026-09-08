"""What comes back when someone answers a request.

Two ways in, and one rule for both. A press hands back the control's id and the
opaque token the bridge minted when it posted the message; a typed answer hands
back a handle and a number. That is all either is trusted for. The session, the
epoch and the revision an answer stands against are read from the record those
resolve to; the actor is the identity the bridge verified for itself. Nothing an
answer carries is taken from the payload that prompted it.

The typed path resolves a number against the options the card offered, kept on
the record when it was posted. It is what the person can see, so it is what
"1" means, and an answer against a card the session has moved past is refused
on revision rather than applied to whatever the request became.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Protocol

from switch_core.bridges.collaboration.models import InboundInteraction, InboundMessage
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .contract import ApprovalResult, Command, Origin, RequestAnswer, Surface
from .renderers import parse_answer_action
from .text import TextAnswer, parse_text_answer

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

# Fixed so that a command id is a function of what was decided rather than of
# when. Regenerating it must give the same answer on any host, in any process.
_COMMAND_NAMESPACE = uuid.UUID("6f5a2d18-9a1e-4f0b-9d3c-0a2f7c1b84e5")


def answer_command(
    post: SessionRequestPost, *, option_id: str, origin: Origin
) -> Command:
    """The `request.answer` an operated control stands for.

    `expectedRevision` comes off the record rather than the callback, so an
    answer to a card that has since been superseded is rejected by the session
    instead of applied to whatever the request became.
    """
    return Command(
        contract_version=1,
        command_id=_command_id(post, option_id=option_id, actor_id=origin.actor_id),
        session_id=post.session_id,
        epoch=post.epoch,
        origin=origin,
        body=RequestAnswer(
            type="request.answer",
            request_id=post.request_id,
            expected_revision=post.revision,
            answer=ApprovalResult(kind="approval", option_id=option_id),
        ),
    )


def _command_id(post: SessionRequestPost, *, option_id: str, actor_id: str) -> str:
    """Derived, so that one person pressing twice is one command.

    Two people choosing differently stay two commands, and the session settles
    on whichever arrives first; the other is refused on its revision.
    """
    key = "|".join(
        [
            post.session_id,
            post.epoch,
            post.request_id,
            str(post.revision),
            option_id,
            actor_id,
        ]
    )
    return str(uuid.uuid5(_COMMAND_NAMESPACE, key))


def _chosen(post: SessionRequestPost, answer: TextAnswer) -> str | None:
    """Which option a typed answer picked, out of the ones the card offered.

    A number is a position on the card, counted as the card counts. A word is
    the one option whose decision it names, and only when there is exactly one:
    `acceptForSession` and `cancel` are reachable by number alone, because
    "yes" must never quietly grant a permission for the rest of a session.
    """
    options = post.options
    if answer.index is not None:
        if not 1 <= answer.index <= len(options):
            return None
        return str(options[answer.index - 1]["optionId"])
    matching = [option for option in options if option["decision"] == answer.decision]
    return str(matching[0]["optionId"]) if len(matching) == 1 else None


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
    """

    def __init__(
        self,
        *,
        bridge_id: str,
        surface: Surface,
        posts: SessionRequestPostStore,
        session_factory: async_sessionmaker[AsyncSession],
        identify: Callable[[InboundActor], Awaitable[str | None]],
    ) -> None:
        self._bridge_id = bridge_id
        self._surface = surface
        self._posts = posts
        self._session_factory = session_factory
        self._identify = identify

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
        return answer_command(post, option_id=option_id, origin=origin)

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

        if message.sender_is_app:
            logger.warning(
                "Ignoring an answer to request %s on bridge %s: it was posted by "
                "an app, and a decision is attributed to whoever made it. No "
                "button press can come from an app either.",
                post.request_id,
                self._bridge_id,
            )
            return None

        option_id = _chosen(post, answer)
        if option_id is None:
            logger.warning(
                "Ignoring an answer to request %s on bridge %s: %s names none of "
                "the %d options that card offered.",
                post.request_id,
                self._bridge_id,
                answer.index if answer.index is not None else answer.decision,
                len(post.options),
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
        return answer_command(post, option_id=option_id, origin=origin)

    async def _post_for(
        self, message: InboundMessage, answer: TextAnswer
    ) -> SessionRequestPost | None:
        """The card an answer is against: the one it named, or the one it replies to.

        A bare decision names nothing, so it only counts as a direct reply to a
        card. Anywhere else it is someone agreeing with someone.
        """
        async with self._session_factory() as session:
            if answer.handle is not None:
                return await self._posts.get_by_handle(
                    session, self._bridge_id, message.channel_id, answer.handle
                )
            if message.root_id is None:
                return None
            return await self._posts.get_by_post(
                session, self._bridge_id, message.root_id
            )
