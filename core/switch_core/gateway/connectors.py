from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.db.models import User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_api_key_store,
    get_connector_lifecycle,
    get_connector_store,
    get_session,
)
from switch_core.gateway.schemas import (
    ConnectorDetail,
    ConnectorTypeInfo,
    CreateConnectorRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/types")
async def list_connector_types(
    connector_lifecycle: Annotated[
        ServerSideConnectorLifecycleService, Depends(get_connector_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[ConnectorTypeInfo]:
    return [
        ConnectorTypeInfo(
            key=t,
            config_schema=connector_lifecycle.get_config_schema(t),
        )
        for t in connector_lifecycle.get_registered_types()
    ]


@router.post("")
async def create_connector(
    req: CreateConnectorRequest,
    connector_lifecycle: Annotated[
        ServerSideConnectorLifecycleService, Depends(get_connector_lifecycle)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> ConnectorDetail:
    try:
        record = await connector_lifecycle.register(
            connector_type=req.type,
            display_name=req.display_name,
            connection_config=dict(req.connection_config),
            user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ConnectorDetail(
        connector_id=record.id,
        connector_type=record.type,
        display_name=record.display_name,
        status=record.status,
        agent_names=connector_lifecycle.get_agent_names(record.id),
        created_at=str(record.created_at),
    )


@router.get("")
async def list_connectors(
    session: Annotated[AsyncSession, Depends(get_session)],
    connector_store: Annotated[ServerConnectorStore, Depends(get_connector_store)],
    connector_lifecycle: Annotated[
        ServerSideConnectorLifecycleService, Depends(get_connector_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[ConnectorDetail]:
    records = await connector_store.get_all(session)
    return [
        ConnectorDetail(
            connector_id=r.id,
            connector_type=r.type,
            display_name=r.display_name,
            status=r.status,
            agent_names=connector_lifecycle.get_agent_names(r.id),
            created_at=str(r.created_at),
        )
        for r in records
    ]


@router.get("/{connector_id}")
async def get_connector(
    connector_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    connector_store: Annotated[ServerConnectorStore, Depends(get_connector_store)],
    connector_lifecycle: Annotated[
        ServerSideConnectorLifecycleService, Depends(get_connector_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> ConnectorDetail:
    record = await connector_store.get(session, connector_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Connector not found")

    return ConnectorDetail(
        connector_id=record.id,
        connector_type=record.type,
        display_name=record.display_name,
        status=record.status,
        agent_names=connector_lifecycle.get_agent_names(record.id),
        created_at=str(record.created_at),
    )


@router.delete("/{connector_id}")
async def delete_connector(
    connector_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    connector_store: Annotated[ServerConnectorStore, Depends(get_connector_store)],
    api_key_store: Annotated[ApiKeyStore, Depends(get_api_key_store)],
    connector_lifecycle: Annotated[
        ServerSideConnectorLifecycleService, Depends(get_connector_lifecycle)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, bool]:
    record = await connector_store.get(session, connector_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Connector not found")

    reg_key = await api_key_store.get(session, record.api_key_id)
    if (reg_key is None or reg_key.user_id != user.id) and user.role != "admin":
        raise HTTPException(
            status_code=403, detail="Not authorized to delete this connector"
        )

    try:
        await connector_lifecycle.remove(connector_id)
    except ValueError as exc:
        # Deleted between the read above and the removal. `remove` refuses to
        # report a removal it did not perform, so the race surfaces as the
        # same 404 the read would have given a moment earlier.
        raise HTTPException(status_code=404, detail="Connector not found") from exc
    return {"ok": True}
