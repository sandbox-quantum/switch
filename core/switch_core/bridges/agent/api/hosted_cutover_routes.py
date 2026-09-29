"""The worker's cutover manifest: what its retained volume held before the upgrade."""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.hosted_worker_routes import (
    refusal,
    require_self,
    require_worker,
)
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_protocol, get_session
from switch_core.bridges.agent.hosted_cutover import (
    CutoverConflict,
    CutoverManifest,
    CutoverUnrecorded,
    confirm_manifest,
    owed_notices,
    post_cutover_notices,
    queue_imports,
)
from switch_core.bridges.agent.hosted_mailbox import offer_pending
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import Agent, HostedLaunch, require_tenant_id
from switch_core.db.stores.hosted_launch_store import lock_launch
from switch_core.db.stores.hosted_mailbox_store import MailboxFull

logger = logging.getLogger(__name__)

router = APIRouter()


class CutoverUpload(CutoverManifest):
    model_config = ConfigDict(extra="forbid")
    connection_id: str
    generation: int


@router.post("/{agent_id}/connection/cutover-manifest")
async def cutover_manifest(
    agent_id: str,
    body: CutoverUpload,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """Confirm the volume's manifest is the one recorded before the upgrade, and deliver what it owes."""
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
        await confirm_manifest(session, launch.id, body.manifest_sha256)
        await queue_imports(session, launch.id)
    except CutoverUnrecorded as exc:
        raise refusal(409, "cutover_manifest_unrecorded", str(exc)) from exc
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
