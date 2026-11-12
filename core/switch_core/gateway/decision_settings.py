"""A workspace's decision backend for auto-route — that workspace's admins only.

Tenant-scoped, unlike Switch Trust's settings (`gateway/trust_settings.py`):
every route is gated by `require_tenant_admin` and reads or writes the row of
the workspace the request is bound to, never another's. No row means the
server default (`decision/settings.py`). What is shown, saved and tested is
`decision/admin.py`, which the agent operations share: the key is never
returned, and a machine can be chosen only by its owner, from their own
machines in this workspace (the operator role alone is not enough: it is not
their machine).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import User, require_tenant_id
from switch_core.decision.admin import (
    DecisionSettingsRefused,
    clear_settings,
    run_sample,
    save_settings,
    settings_view,
)
from switch_core.decision.client import DynamicDecisionClient
from switch_core.gateway.auth import require_tenant_admin
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.schemas import (
    DecisionSettingsResponse,
    DecisionSettingsTestRequest,
    DecisionSettingsUpdateRequest,
    DecisionTestResponse,
)

router = APIRouter()


def get_decision_client(request: Request) -> DynamicDecisionClient:
    """The process's decision client (`decision/setup.py`)."""
    client: DynamicDecisionClient = request.app.state.decision_client
    return client


@router.get("/decision-settings")
async def get_decision_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    admin: Annotated[User, Depends(require_tenant_admin)],
) -> DecisionSettingsResponse:
    return await settings_view(
        session,
        client,
        config.keyring,
        tenant_id=require_tenant_id(),
        user_id=admin.id,
    )


@router.put("/decision-settings")
async def update_decision_settings(
    req: DecisionSettingsUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    admin: Annotated[User, Depends(require_tenant_admin)],
) -> DecisionSettingsResponse:
    try:
        return await save_settings(
            session,
            client,
            config.keyring,
            tenant_id=require_tenant_id(),
            user_id=admin.id,
            req=req,
        )
    except DecisionSettingsRefused as refused:
        raise HTTPException(status_code=422, detail=str(refused)) from refused


@router.delete("/decision-settings", status_code=204)
async def delete_decision_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    _admin: Annotated[User, Depends(require_tenant_admin)],
) -> Response:
    await clear_settings(session, client, tenant_id=require_tenant_id())
    return Response(status_code=204)


@router.post("/decision-settings/test")
async def test_decision_settings(
    req: DecisionSettingsTestRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    client: Annotated[DynamicDecisionClient, Depends(get_decision_client)],
    admin: Annotated[User, Depends(require_tenant_admin)],
) -> DecisionTestResponse:
    """Run the sample decision against the values entered, saved or not; an
    omitted key means the stored one. `backend: "default"` tests the server
    default, with the server's own endpoint and key and never the
    workspace's; `machine` asks the caller's own machine, when it reports the
    model running. Nothing is saved, and no room's data is sent."""
    try:
        return await run_sample(
            session,
            client,
            config.keyring,
            tenant_id=require_tenant_id(),
            user_id=admin.id,
            req=req,
        )
    except DecisionSettingsRefused as refused:
        raise HTTPException(status_code=422, detail=str(refused)) from refused
