"""Room-safe presentation metadata for SDK collaboration messages."""

import logging
from collections.abc import Awaitable, Callable

from sqlalchemy import Row, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
)
from switch_core.sessions.contract import TurnUpsert

logger = logging.getLogger(__name__)


async def notification_recipient(
    db: AsyncSession,
    *,
    bridge_id: str,
    room_id: str,
    surface: str,
    actor_id: str | None,
    agent: Agent,
    thread_id: str | None,
) -> str | None:
    """Slack participants follow replies by default; mention only elsewhere.

    Whoever asked (`actor_id`, their room identity, when it is known) is named
    first. They are the one waiting on the answer, and on a platform where a
    mention is the whole notification they are also the one most likely to be
    looking. The agent's owner is the fallback, so a turn started by someone
    who has claimed no account here still reaches somebody.

    Membership and bridge checks prevent mentioning identities from another
    room or workspace. No follower API is needed for the usual threaded case.
    """
    if surface == "slack" and thread_id:
        return None
    members = (
        select(ExternalUser.external_user_id)
        .join(ClientRoom, ClientRoom.client_id == ExternalUser.client_id)
        .where(ExternalUser.bridge_id == bridge_id, ClientRoom.room_id == room_id)
    )

    async def claimed_by(user_id: str | None) -> str | None:
        if not user_id:
            return None
        claimant: str | None = await db.scalar(
            members.join(
                ExternalUserClaim, ExternalUserClaim.external_user_id == ExternalUser.id
            )
            .where(ExternalUserClaim.user_id == user_id)
            .order_by(ExternalUser.id)
            .limit(1)
        )
        return claimant

    async def initiator() -> str | None:
        if actor_id is None:
            return None
        actor = await db.scalar(
            members.join(Client, Client.id == ExternalUser.client_id)
            .where(Client.transport_user_id == actor_id)
            .order_by(ExternalUser.id)
            .limit(1)
        )
        return actor or await claimed_by(actor_id)

    return await initiator() or await claimed_by(agent.owner_id)


async def request_card_recipient(
    db: AsyncSession,
    *,
    bridge_id: str,
    room_id: str,
    actor_id: str | None,
    agent: Agent,
    may_answer: Callable[[str], Awaitable[bool]],
) -> str | None:
    """The one person a request card in a thread names: someone who may answer it.

    A thread is followed only by the people already in it, and the person who
    has to answer is often not one of them, so a card there that names nobody
    can wait unseen. `notification_recipient` names whoever asked, which suits
    a post the asker is waiting on; a card needs whoever may answer, and on
    the default policy only the owner may.

    Whoever asked comes first, then the owner, each only when `may_answer`
    (given their room identity) admits them, which is the check an answer is
    put through. The asker is the one waiting on the card, so when they may
    answer it they are named even if the owner may too. Exactly one person or
    nobody: a policy that admits the whole room is not a reason to page the
    whole room. A person is named by the account they hold on this bridge and
    in this room, so somebody with no account here (an agent, for one) is not
    named at all. An owner may hold several such accounts and a policy may
    admit only one of them, so each is tried in turn.
    """
    members = (
        select(ExternalUser.external_user_id, Client.transport_user_id)
        .join(Client, Client.id == ExternalUser.client_id)
        .join(ClientRoom, ClientRoom.client_id == ExternalUser.client_id)
        .where(ExternalUser.bridge_id == bridge_id, ClientRoom.room_id == room_id)
    )
    refused: str | None = None
    if actor_id is not None:
        asker = (
            await db.execute(
                members.where(Client.transport_user_id == actor_id)
                .order_by(ExternalUser.id)
                .limit(1)
            )
        ).first()
        if asker is not None:
            if await may_answer(actor_id):
                return str(asker.external_user_id)
            refused = actor_id
    if agent.owner_id is None:
        logger.info("Agent %s has no owner to name on its request card.", agent.name)
    else:
        owner_accounts: list[Row[tuple[str, str]]] = list(
            (
                await db.execute(
                    members.join(
                        ExternalUserClaim,
                        ExternalUserClaim.external_user_id == ExternalUser.id,
                    )
                    .where(ExternalUserClaim.user_id == agent.owner_id)
                    .order_by(ExternalUser.id)
                )
            ).all()
        )
        if not owner_accounts:
            logger.info(
                "The owner of agent %s has no linked account in room %s on "
                "bridge %s, so its request card cannot name them.",
                agent.name,
                room_id,
                bridge_id,
            )
        for owner in owner_accounts:
            if owner.transport_user_id == refused:
                continue
            if await may_answer(owner.transport_user_id):
                return str(owner.external_user_id)
        if owner_accounts:
            logger.info(
                "The owner of agent %s may not answer in room %s from any "
                "account linked here, so its request card does not name them.",
                agent.name,
                room_id,
            )
    logger.info(
        "Request card of agent %s in room %s names nobody: neither whoever "
        "asked nor its owner has an account here that may answer it.",
        agent.name,
        room_id,
    )
    return None


def activity_error_summary(turn: TurnUpsert, *, online: bool) -> str | None:
    """Describe state without leaking provider notices or session-private output."""
    if turn.status == "error":
        return "The agent could not complete this request. Open Switch Console for details."
    if turn.status not in {"queued", "running"}:
        return None
    if not online:
        return "The agent host is offline. This request cannot continue until it reconnects."
    return None
