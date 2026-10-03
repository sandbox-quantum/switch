from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.connections.loader import CATALOG
from switch_core.db.models import ProviderConnection, User, require_tenant_id
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session

router = APIRouter(prefix="/provider-connections")


@router.get("/catalog")
async def catalog(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    connected = set(
        await session.scalars(
            select(ProviderConnection.provider).where(
                ProviderConnection.tenant_id == require_tenant_id(),
                ProviderConnection.user_id == user.id,
                ProviderConnection.provider.in_(list(CATALOG)),
            )
        )
    )
    return {
        "connections": [
            {
                "slug": entry.definition.slug,
                "name": entry.definition.name,
                "category": entry.definition.category,
                "description": entry.definition.description,
                "enabled": entry.definition.enabled,
                "auth_type": entry.definition.auth.type,
                "status": (
                    "coming_soon"
                    if not entry.definition.enabled
                    else "connected"
                    if entry.definition.slug in connected
                    else "not_connected"
                ),
            }
            for entry in CATALOG.values()
        ]
    }
