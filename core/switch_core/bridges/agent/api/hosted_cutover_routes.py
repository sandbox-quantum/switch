"""The worker's cutover manifest: what its retained volume held before the upgrade."""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.hosted_worker_routes import (
    post_notice_once,
    refusal,
    require_self,
    require_worker,
)
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_protocol, get_session
from switch_core.bridges.agent.hosted_cutover import (
    CutoverConflict,
    CutoverManifest,
    CutoverNotice,
    apply_manifest,
    mark_notice_posted,
    owed_notices,
)
from switch_core.bridges.agent.hosted_mailbox import offer_pending
from switch_core.bridges.agent.protocol.hosted_workers import NOTICE_MESSAGES
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent, HostedLaunch, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_launch_store import lock_launch
from switch_core.db.stores.hosted_mailbox_store import MailboxFull

logger = logging.getLogger(__name__)

router = APIRouter()


class CutoverUpload(CutoverManifest):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int


async def post_cutover_notices(
    protocol: ProtocolService, agent: Agent, notices: list[CutoverNotice]
) -> int:
    """Post each owed notice once, and record it; one that fails stays owed for the next upload."""
    unposted = 0
    for notice in notices:
        subject = (
            notice.message_id
            if notice.request_id is None
            else f"request:{notice.request_id}"
        )
        try:
            await post_notice_once(
                protocol,
                agent,
                notice.room_id,
                key=json.dumps([agent.id, notice.room_id, subject, notice.reason]),
                body=NOTICE_MESSAGES[notice.reason].format(name=agent.name),
                thread_id=notice.thread_id,
                anchor=None,
            )
        except Exception:
            logger.error(
                "Could not post the %s cutover notice for %s in room %s",
                notice.reason,
                subject,
                notice.room_id,
                exc_info=True,
            )
            unposted += 1
            continue
        async with tenant_session(protocol.session_factory, require_tenant_id()) as db:
            await mark_notice_posted(db, notice.item_id)
            await db.commit()
    return unposted


@router.post("/{agent_id}/connection/cutover-manifest")
async def cutover_manifest(
    agent_id: str,
    body: CutoverUpload,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """Apply the volume's manifest once, queue what it imports, and post what it owes rooms."""
    require_self(agent_id, agent)
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    assert conn.worker is not None
    await lock_launch(session, conn.worker.launch_id)
    launch = await session.get(
        HostedLaunch,
        (require_tenant_id(), conn.worker.launch_id),
        populate_existing=True,
    )
    if launch is None or launch.revision != conn.worker.launch_revision:
        raise refusal(
            409,
            "generation_changed",
            "The launch moved to a newer revision; upload the manifest again after "
            "reattaching.",
        )
    try:
        await apply_manifest(
            session,
            agent_id=agent.id,
            launch_id=launch.id,
            manifest=CutoverManifest(
                manifest_sha256=body.manifest_sha256, items=body.items
            ),
        )
    except CutoverConflict as exc:
        raise refusal(409, "cutover_manifest_conflict", str(exc)) from exc
    except MailboxFull as exc:
        raise refusal(503, "mailbox_full", str(exc)) from exc
    notices = await owed_notices(session, agent.id)
    await session.commit()
    unposted = await post_cutover_notices(protocol, agent, notices)
    await offer_pending(
        session, protocol.connections, protocol.event_buffer.boot, launch
    )
    return {"manifest_sha256": body.manifest_sha256, "unposted_notices": unposted}
