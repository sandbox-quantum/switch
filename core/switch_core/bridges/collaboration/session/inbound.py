"""What comes back when someone operates a control the renderers put out.

A platform hands back the control's id and the opaque token the bridge minted
when it posted the message, and that is deliberately all it is trusted for. The
session, the epoch and the revision an answer stands against are read from the
record the token resolves to; the actor is the identity the bridge verified for
itself. Nothing an answer carries is taken from the payload that prompted it.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.db.models import SessionRequestPost
from switch_core.db.stores.session_request_post_store import SessionRequestPostStore

from .contract import ApprovalResult, Command, Origin, RequestAnswer, Surface
from .renderers import parse_answer_action

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


class SessionInteractions:
    """One bridge's inbound half: a control someone operated, as a command.

    `identify` is how the bridge names the person who acted. It is given the
    interaction and returns the Switch identity behind the platform account, or
    None when there is not one — which is a refusal, not a default actor.
    """

    def __init__(
        self,
        *,
        bridge_id: str,
        surface: Surface,
        posts: SessionRequestPostStore,
        session_factory: async_sessionmaker[AsyncSession],
        identify: Callable[[InboundInteraction], Awaitable[str | None]],
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
