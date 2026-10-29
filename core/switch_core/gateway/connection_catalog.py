from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.connections.loader import CATALOG
from switch_core.db.models import ServiceConnection, User, require_tenant_id
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session

router = APIRouter(prefix="/provider-connections")


@router.get("/catalog")
async def catalog(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    """The catalog as a Console from before service connections reads it.
    With them switched on, every enabled service is listed as enabled; off,
    GitHub alone, whose own connect routes stay, and every other service is
    coming. Today's Console reads it only where `/service-connections` is
    missing, and offers connectors only with the flag on, so nothing it
    offers comes from here."""
    services_on = config.service_connections_enabled
    connected = set(
        await session.scalars(
            select(ServiceConnection.service).where(
                ServiceConnection.tenant_id == require_tenant_id(),
                ServiceConnection.user_id == user.id,
                ServiceConnection.service.in_(list(CATALOG)),
            )
        )
    )
    entries = []
    for entry in CATALOG.values():
        definition = entry.definition
        enabled = definition.enabled and (services_on or definition.slug == "github")
        entries.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "category": definition.category,
                "description": definition.description,
                "enabled": enabled,
                "auth_type": definition.auth.type,
                "status": (
                    "coming_soon"
                    if not enabled
                    else "connected"
                    if definition.slug in connected
                    else "not_connected"
                ),
            }
        )
    return {"connections": entries}
