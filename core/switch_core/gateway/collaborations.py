from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import BridgeInstallLink
from switch_core.db.models import CollaborationBridge, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.dependencies import (
    get_bridge_store,
    get_collab_lifecycle,
    get_external_user_store,
    get_room_service,
    get_room_store,
    get_session,
)
from switch_core.gateway.schemas import (
    BridgeCreateRequest,
    BridgeDetail,
    BridgeTypeInfo,
    BridgeUpdateRequest,
    ExternalUserSummary,
)
from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)

router = APIRouter()


async def _home_url(
    bridge_id: str, collab_lifecycle: CollaborationBridgeLifecycleService
) -> str | None:
    """Link that opens the bridge's workspace in its messaging app, built by
    the live adapter. None when the bridge is not running or the platform has
    no such link — the same "offer it only when it works" rule the per-room
    channel deeplink follows."""
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        return None
    try:
        return await adapter.home_deeplink()
    except Exception:
        logger.warning(
            "Failed to build home deeplink for bridge %s", bridge_id, exc_info=True
        )
        return None


async def _install_links(
    bridge_id: str, collab_lifecycle: CollaborationBridgeLifecycleService
) -> list[BridgeInstallLink]:
    """One-click "add the app to a chat" links, built by the live adapter.
    Empty when the bridge is not running or its platform has none — the same
    "offer it only when it works" rule as the home link."""
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if adapter is None:
        return []
    try:
        return await adapter.install_links()
    except Exception:
        logger.warning(
            "Failed to build install links for bridge %s", bridge_id, exc_info=True
        )
        return []


async def _detail(
    bridge: CollaborationBridge,
    *,
    room_count: int,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    is_default: bool | None = None,
) -> BridgeDetail:
    """One place every response shape is built, so a new field cannot reach
    some endpoints and miss others. `is_default` overrides the stored value for
    a caller that just changed it in the same request."""
    return BridgeDetail(
        bridge_id=bridge.id,
        bridge_type=bridge.type,
        display_name=bridge.display_name,
        status=bridge.status,
        agent_greetings_enabled=bridge.agent_greetings_enabled,
        is_default=bridge.is_default if is_default is None else is_default,
        room_count=room_count,
        created_at=str(bridge.created_at),
        home_url=await _home_url(bridge.id, collab_lifecycle),
        install_links=await _install_links(bridge.id, collab_lifecycle),
    )


@router.get("/types")
async def list_bridge_types(
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[BridgeTypeInfo]:
    return [
        BridgeTypeInfo(
            key=t,
            config_schema=collab_lifecycle.get_config_schema(t),
        )
        for t in collab_lifecycle.get_registered_types()
    ]


@router.post("")
async def create_bridge(
    req: BridgeCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    # Admin-only: a bridge is an unowned, workspace-wide integration holding
    # platform secrets, so there is no owner to scope to (unlike connectors,
    # whose authz is owner-or-admin) — registering one is an admin action.
    _user: Annotated[User, Depends(require_admin)],
) -> BridgeDetail:
    try:
        bridge = await collab_lifecycle.register(
            bridge_type=req.bridge_type,
            display_name=req.display_name,
            connection_config=dict(req.connection_config),
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    is_default = bridge.is_default
    if req.set_as_default:
        await bridge_store.set_default(session, bridge.id)
        await session.commit()
        is_default = True

    return await _detail(
        bridge, room_count=0, collab_lifecycle=collab_lifecycle, is_default=is_default
    )


@router.post("/{bridge_id}/default")
async def set_default_bridge(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(require_admin)],
) -> BridgeDetail:
    """Nominate a bridge as the instance default, demoting the previous one."""
    try:
        bridge = await bridge_store.set_default(session, bridge_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await session.commit()

    rooms = await room_store.get_by_bridge(session, bridge_id)
    return await _detail(
        bridge, room_count=len(rooms), collab_lifecycle=collab_lifecycle
    )


@router.get("")
async def list_bridges(
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[BridgeDetail]:
    bridges = await bridge_store.get_all(session)

    details = []
    for bridge in bridges:
        rooms = await room_store.get_by_bridge(session, bridge.id)
        details.append(
            await _detail(
                bridge, room_count=len(rooms), collab_lifecycle=collab_lifecycle
            )
        )

    return details


@router.patch("/{bridge_id}")
async def update_bridge(
    bridge_id: str,
    payload: BridgeUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    # Admin-only for the same reason as registering one: a bridge is an unowned,
    # workspace-wide integration, so there is no owner to scope mutation to.
    _user: Annotated[User, Depends(require_admin)],
) -> BridgeDetail:
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    bridge = await bridge_store.set_agent_greetings_enabled(
        session, bridge_id, payload.agent_greetings_enabled
    )
    await session.commit()
    rooms = await room_store.get_by_bridge(session, bridge_id)
    return await _detail(
        bridge, room_count=len(rooms), collab_lifecycle=collab_lifecycle
    )


@router.get("/{bridge_id}/users")
async def list_bridge_users(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    external_user_store: Annotated[ExternalUserStore, Depends(get_external_user_store)],
    _user: Annotated[User, Depends(get_current_user)],
) -> list[ExternalUserSummary]:
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    users = await external_user_store.get_by_bridge(session, bridge_id)
    return [
        ExternalUserSummary(
            id=u.id,
            bridge_id=u.bridge_id,
            external_user_id=u.external_user_id,
            external_username=u.external_username,
        )
        for u in users
    ]


@router.delete("/{bridge_id}")
async def delete_bridge(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    room_store: Annotated[RoomStore, Depends(get_room_store)],
    room_service: Annotated[RoomService, Depends(get_room_service)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    # Admin-only: deleting a bridge cascades into deleting every room on it, so
    # this is the most destructive operation on the router.
    _user: Annotated[User, Depends(require_admin)],
) -> dict[str, bool]:
    bridge = await bridge_store.get(session, bridge_id)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Bridge not found")

    rooms = await room_store.get_by_bridge(session, bridge_id)
    for room in rooms:
        await room_service.delete_room(room.id)

    await collab_lifecycle.remove(bridge_id)
    return {"ok": True}
