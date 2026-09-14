"""Room-safe presentation metadata for SDK collaboration messages."""

from urllib.parse import urlencode, urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
)
from switch_core.sessions.contract import Origin, Session, TurnUpsert


def session_console_url(
    server: str | None, agent_id: str, room_id: str, session_id: str
) -> str | None:
    """Use the configured server and current SDK identity, never legacy state."""
    if (
        not server
        or urlsplit(server).scheme not in {"http", "https"}
        or not urlsplit(server).netloc
    ):
        return None
    return "switchdash://session?" + urlencode(
        {
            "server": server.rstrip("/"),
            "agent": agent_id,
            "room": room_id,
            "session": session_id,
        }
    )


async def notification_recipient(
    db: AsyncSession,
    *,
    bridge_id: str,
    room_id: str,
    origin: Origin,
    agent: Agent,
    thread_id: str | None,
) -> str | None:
    """Slack participants follow replies by default; mention only other origins.

    Whoever asked is named first. They are the one waiting on the answer, and
    on a platform where a mention is the whole notification they are also the
    one most likely to be looking. The agent's owner is the fallback, so a turn
    started by someone who has claimed no account here still reaches somebody.

    Membership and bridge checks prevent mentioning identities from another
    room or workspace. No follower API is needed for the usual threaded case.
    """
    if origin.surface == "slack" and thread_id:
        return None
    members = (
        select(ExternalUser.external_user_id)
        .join(ClientRoom, ClientRoom.client_id == ExternalUser.client_id)
        .where(ExternalUser.bridge_id == bridge_id, ClientRoom.room_id == room_id)
    )

    async def claimed_by(user_id: str | None) -> str | None:
        # Console commands identify their user directly rather than a puppet.
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
        actor = await db.scalar(
            members.join(Client, Client.id == ExternalUser.client_id)
            .where(Client.matrix_user_id == origin.actor_id)
            .order_by(ExternalUser.id)
            .limit(1)
        )
        return actor or await claimed_by(origin.actor_id)

    return await initiator() or await claimed_by(agent.owner_id)


def activity_error_summary(
    turn: TurnUpsert, session: Session, *, online: bool
) -> str | None:
    """Describe state without leaking provider notices or session-private output."""
    if turn.status == "error":
        return "The agent could not complete this request. Open Switch Console for details."
    if turn.status not in {"queued", "running"}:
        return None
    if not online:
        return "The agent host is offline. This request cannot continue until it reconnects."
    if session.status == "error":
        return (
            "The agent session encountered an error. Open Switch Console for details."
        )
    return None
