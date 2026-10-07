"""Delivering the wake mailbox to cloud agents, and keeping it tidy.

An agent on a cloud machine's controller has its rows handed to the live
event stream once its controller is connected again. Rows that could not be
delivered in time owe their room a notice, which is posted after the commit.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Literal, cast

from sqlalchemy import exists, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.types import AgentEvent
from switch_core.config import hosted_configured
from switch_core.db.models import (
    Agent,
    Client,
    HostedWakeMailbox,
    Message,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_mailbox_store import (
    NOTICE_RETRIES_PER_PASS,
    HostedMailboxStore,
    MailboxNotice,
    by_room,
)

logger = logging.getLogger(__name__)

NoticeReason = Literal["expired", "expired_uncertain"]

#: What a room is told, by notice reason, when a message was not processed.
NOTICE_MESSAGES: dict[NoticeReason, str] = {
    "expired": "I could not process this message in time, so I did not process it. Please send it again.",
    "expired_uncertain": "I could not confirm whether my cloud machine received this message in time, so it may or may not have been processed. Check the conversation before sending it again.",
}


def controller_event(row: HostedWakeMailbox) -> AgentEvent:
    """The live event a mailbox row of a controller's agent was written from."""
    return AgentEvent.model_validate(
        {
            "type": row.event["type"],
            "room_id": row.room_id,
            "bridge_id": row.event.get("bridge_id"),
            "channel_type": row.event.get("channel_type"),
            "payload": row.event["payload"],
        }
    )


async def deliver_to_controllers(protocol: AgentCore, agent_ids: list[str]) -> int:
    """Hand each live controller-backed agent its `pending` rows on the live
    event stream, which its controller reads from where it attached.

    Admitted and committed before they are queued, so a row is handed over
    once. Returns how many rows were handed over.
    """
    presence = protocol.connections.controllers
    delivered = 0
    for agent_id in agent_ids:
        if not presence.is_live(agent_id):
            continue
        async with tenant_session(
            protocol.session_factory, require_tenant_id()
        ) as session:
            rows = await HostedMailboxStore().admit_pending(session, agent_id)
            await session.commit()
        for row in rows:
            protocol.event_buffer.enqueue(agent_id, row.room_id, controller_event(row))
        if rows:
            logger.info(
                "Wake mailbox handed %d event(s) to agent %s on its controller",
                len(rows),
                agent_id,
            )
        delivered += len(rows)
    return delivered


async def post_notice_once(
    protocol: AgentCore,
    agent: Agent,
    room_id: str,
    *,
    key: str,
    body: str,
    thread_id: str | None,
    anchor: str | None,
) -> bool:
    """Post `body` to the room unless the agent already posted one under `key`.

    `anchor`, when set, is the message the notice is about, and must be in
    the room. True when this call posted it.
    """
    async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"room-failure:{require_tenant_id()}:{key}"},
        )
        if anchor is not None:
            target = await db.scalar(
                select(Message.id).where(
                    Message.room_id == room_id, Message.transport_event_id == anchor
                )
            )
            if target is None:
                raise ValueError(f"Message {anchor} is not in room {room_id}")
        sender = (
            select(Client.transport_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .where(Agent.id == agent.id)
            .scalar_subquery()
        )
        previous = await db.scalar(
            select(Message.id)
            .where(
                Message.room_id == room_id,
                Message.sender_id == sender,
                Message.content["switch_room_failure"].astext == key,
            )
            .limit(1)
        )
        if previous is not None:
            return False
        await protocol.send_message(
            agent.id,
            room_id,
            body,
            thread_id=thread_id,
            extra_content={"switch_room_failure": key},
        )
        await db.commit()
    return True


async def post_room_notice(
    protocol: AgentCore,
    agent: Agent,
    room_id: str,
    message_id: str,
    thread_id: str | None,
    reason: NoticeReason,
) -> bool:
    """Tell a room why a message was not processed, once per message and reason.

    True when this call posted it.
    """
    return await post_notice_once(
        protocol,
        agent,
        room_id,
        key=json.dumps([agent.id, room_id, message_id, reason]),
        body=NOTICE_MESSAGES[reason].format(name=agent.name),
        thread_id=thread_id,
        anchor=message_id,
    )


async def post_mailbox_notices(
    protocol: AgentCore, notices: Sequence[MailboxNotice]
) -> None:
    """Post what the mailbox owes rooms, one notice per room and reason, after the commit.

    Each row keeps its `notice_owed` mark until the room has the notice, so a
    send that fails is logged and left for the upkeep to retry; the per
    message and reason receipt keeps a retry from posting it twice. A notice
    for a deleted agent can never be posted: it is marked dropped, not posted.
    """
    agents: dict[str, Agent | None] = {}
    store = HostedMailboxStore()
    for notice, message_ids in by_room(notices):
        if notice.agent_id not in agents:
            async with tenant_session(
                protocol.session_factory, require_tenant_id()
            ) as db:
                agents[notice.agent_id] = await db.get(Agent, notice.agent_id)
        agent = agents[notice.agent_id]
        if agent is None:
            logger.warning(
                "Mailbox notice %s for room %s dropped: agent %s was deleted",
                notice.reason,
                notice.room_id,
                notice.agent_id,
            )
            async with tenant_session(
                protocol.session_factory, require_tenant_id()
            ) as db:
                await store.notice_dropped(
                    db,
                    notice.agent_id,
                    notice.room_id,
                    notice.reason,
                    message_ids,
                    "agent_deleted",
                )
                await db.commit()
            continue
        try:
            await post_room_notice(
                protocol,
                agent,
                notice.room_id,
                notice.message_id,
                notice.thread_id,
                cast(NoticeReason, notice.reason),
            )
        except Exception:
            logger.warning(
                "Could not post the %s notice for message %s in room %s; "
                "the mailbox upkeep retries it",
                notice.reason,
                notice.message_id,
                notice.room_id,
                exc_info=True,
            )
            continue
        async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
            await store.notice_posted(
                db, notice.agent_id, notice.room_id, notice.reason, message_ids
            )
            await db.commit()


async def retains_hosted_work(session: AsyncSession) -> bool:
    """Whether the bound tenant has a wake mailbox row."""
    return bool(
        await session.scalar(
            select(exists().where(HostedWakeMailbox.tenant_id == require_tenant_id()))
        )
    )


async def mailbox_upkeep(protocol: AgentCore, since: datetime) -> None:
    """One pass over the bound tenant: expire, prune, log the backlog, post owed notices and deliver to live controllers.

    Skipped on a server that does not run cloud agents, unless the tenant still
    holds hosted work from when it did.
    """
    if not hosted_configured(protocol.config):
        async with tenant_session(
            protocol.session_factory, require_tenant_id()
        ) as session:
            if not await retains_hosted_work(session):
                return
    store = HostedMailboxStore()
    now = datetime.now(UTC)
    async with tenant_session(protocol.session_factory, require_tenant_id()) as session:
        notices, tombstoned = await store.expire(session, now)
        pruned = await store.prune(session, now)
        backlog = await store.backlog(session, since)
        waiting = await store.agents_with_pending(session)
        owed = await store.owed_notices(session, NOTICE_RETRIES_PER_PASS)
        await session.commit()
    if notices or tombstoned or pruned:
        logger.info(
            "Wake mailbox upkeep in tenant %s: expired=%d tombstoned=%d pruned=%d",
            require_tenant_id(),
            len(notices),
            tombstoned,
            pruned,
        )
    for agent in backlog:
        logger.info(
            "Wake mailbox backlog agent=%s waiting=%d oldest=%s refused=%d",
            agent.agent_id,
            agent.waiting,
            agent.oldest.isoformat() if agent.oldest else "-",
            agent.refused,
        )
    fresh = {(notice.agent_id, notice.room_id, notice.message_id) for notice in notices}
    retried = [
        notice
        for notice in owed
        if (notice.agent_id, notice.room_id, notice.message_id) not in fresh
    ]
    if retried:
        logger.warning(
            "Wake mailbox in tenant %s retries %d room notice(s) a failed send still owes",
            require_tenant_id(),
            len(retried),
        )
    await post_mailbox_notices(protocol, owed)
    await deliver_to_controllers(protocol, waiting)
