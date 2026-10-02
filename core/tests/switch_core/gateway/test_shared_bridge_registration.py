"""A shared bridge is made by installing the app, and stays on what it was
installed into.

The deployment's own app is in every tenant's workspaces, so a shared bridge
reaches whatever its config names. Registering one by hand, or editing one to
name another workspace, would let a tenant admin put their rooms in somebody
else's. Both are refused before anything is stored.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.models import BridgeStartRefused
from switch_core.db.models import Client, CollaborationBridge, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.collaborations import create_bridge, update_bridge
from switch_core.gateway.schemas import BridgeCreateRequest, BridgeUpdateRequest

_BRIDGE_STORE = CollaborationBridgeStore()


class _Lifecycle:
    """Records what reached it; refuses any start when told to."""

    def __init__(self, *, refuse: bool = False) -> None:
        self.refuse = refuse
        self.registered: list[dict[str, object]] = []
        self.checked: list[dict[str, Any]] = []

    async def register(self, **kwargs: object) -> None:
        self.registered.append(kwargs)

    def validate_connection_config(
        self, bridge_type: str, connection_config: dict[str, object]
    ) -> None: ...

    def supports_channel_creation(self, bridge_type: str) -> bool:
        return False

    async def reject_resource_conflict(
        self,
        bridge_type: str,
        connection_config: dict[str, object],
        *,
        exclude_bridge_id: str,
    ) -> None: ...

    async def check_start_guards(self, **kwargs: Any) -> None:
        self.checked.append(kwargs)
        if self.refuse:
            raise BridgeStartRefused("not installed for this tenant")


def _admin() -> User:
    return User(id="admin", name="admin", email="admin@example.test", role="admin")


async def _shared_bridge(session: AsyncSession) -> str:
    client = Client(
        transport_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="discord",
        display_name="Acme",
        client_id=client.id,
        status="active",
        connection_config={"guild_id": "111", "event_delivery": "shared"},
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _update(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    lifecycle: _Lifecycle,
    connection_config: dict[str, object],
) -> HTTPException:
    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await update_bridge(
                bridge_id=bridge_id,
                payload=BridgeUpdateRequest(connection_config=connection_config),
                session=session,
                bridge_store=_BRIDGE_STORE,
                room_store=RoomStore(),
                collab_lifecycle=lifecycle,  # type: ignore[arg-type]
                _user=_admin(),
            )
    return refused.value


async def _stored_config(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> dict[str, object]:
    async with session_factory() as session:
        bridge = await _BRIDGE_STORE.get(session, bridge_id)
    assert bridge is not None
    return dict(bridge.connection_config or {})


async def test_a_shared_bridge_cannot_be_registered_by_hand() -> None:
    lifecycle = _Lifecycle()

    with pytest.raises(HTTPException) as refused:
        await create_bridge(
            req=BridgeCreateRequest(
                bridge_type="discord",
                display_name="Not mine",
                connection_config={"guild_id": "999", "event_delivery": "shared"},
            ),
            session=None,  # type: ignore[arg-type]
            bridge_store=_BRIDGE_STORE,
            collab_lifecycle=lifecycle,  # type: ignore[arg-type]
            _user=_admin(),
        )

    assert refused.value.status_code == 422
    assert lifecycle.registered == []


async def test_a_shared_bridge_cannot_be_pointed_at_another_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _shared_bridge(session)
        await session.commit()
    lifecycle = _Lifecycle(refuse=True)

    refused = await _update(session_factory, bridge_id, lifecycle, {"guild_id": "999"})

    assert refused.status_code == 422
    # Asked with the config it would have stored, and nothing was stored.
    assert lifecycle.checked[0]["connection_config"]["guild_id"] == "999"
    assert (await _stored_config(session_factory, bridge_id))["guild_id"] == "111"


async def test_how_a_bridge_receives_events_cannot_be_changed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _shared_bridge(session)
        await session.commit()
    lifecycle = _Lifecycle()

    refused = await _update(
        session_factory,
        bridge_id,
        lifecycle,
        {"event_delivery": "own_connection", "bot_token": "pasted-token"},
    )

    assert refused.status_code == 422
    assert (await _stored_config(session_factory, bridge_id))[
        "event_delivery"
    ] == "shared"
