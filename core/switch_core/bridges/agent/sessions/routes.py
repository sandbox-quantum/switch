"""The session API's HTTP door.

Mounted under `/agent/v1`, which is new to this app. The rest of the agent
bridge is unversioned (`/agents/...`), but the contract names its own version
segment and the host SDK builds its URLs from it, so these routes carry it.

Not in `PUBLIC_PATH_PREFIXES`, so `BearerAuthMiddleware` authenticates every one
of them and the handler is given a resolved agent rather than a claim.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_session,
    get_session_lease_service,
)
from switch_core.bridges.agent.sessions.lease_service import SessionLeaseService
from switch_core.bridges.agent.sessions.schemas import LeaseRequest, LeaseResponse
from switch_core.db.models import Agent

# Every name a signature mentions is imported at runtime, deliberately: FastAPI
# evaluates these annotations to find the `Depends`, and one it cannot resolve
# becomes a required query parameter rather than an error.

router = APIRouter(prefix="/agent/v1/sessions")


@router.post("/{session_id}/lease", response_model=LeaseResponse)
async def claim_lease(
    session_id: str,
    req: LeaseRequest,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    leases: Annotated[SessionLeaseService, Depends(get_session_lease_service)],
    db: Annotated[AsyncSession, Depends(get_session)],
) -> LeaseResponse:
    """Take or renew the host lease on a session.

    One route for both, as the contract has it. A body with no `epoch` is an
    acquisition and the response carries the generation the server minted; a
    body with one is a heartbeat under the generation the host already holds.

    Registers the session on first sight. This is the only place that does, and
    it is why the route does not 404 on an id the server has never seen.
    """
    response = await leases.claim(db, session_id, agent.id, req)
    await db.commit()
    return response
