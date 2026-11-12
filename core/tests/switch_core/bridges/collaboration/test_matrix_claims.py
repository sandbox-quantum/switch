"""One Matrix bot account, connected at most once on the instance.

Every connection on an account sees every room the account is in, so two
connections on one bot, in one tenant or two, would each relay all of those
rooms into their own tenant. These run the lifecycle's own claim check, against
bridges stored in the database, the way registration and an edit run it.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    BridgeClaimConflict,
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.matrix.adapter import (
    MatrixAdapter,
    MatrixConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import tenant_scope
from tests.ownership import SoleOwner
from tests.switch_core.bridges.collaboration.matrix_fakes import BOT, HOMESERVER

_MATRIX = {
    "homeserver_url": HOMESERVER,
    "bot_user_id": BOT,
    "access_token": "syt_placeholder_token",
    "accept_invites_from_other_servers": False,
}


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    service = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        provisioning=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
        ownership=SoleOwner(),
        cursor_writer=SoleOwner.cursor_writer(session_factory),
    )
    service.register_adapter("matrix", MatrixAdapter, MatrixConnectionConfig)
    return service


async def _tenant(session_factory: async_sessionmaker[AsyncSession]) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    return tenant_id


async def _bridge(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    tenant_id: str,
    connection_config: dict[str, Any],
    display_name: str = "Incumbent",
) -> None:
    async with session_factory() as session:
        client = Client(
            tenant_id=tenant_id,
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=tenant_id,
                type="matrix",
                display_name=display_name,
                client_id=client.id,
                status="active",
                connection_config=connection_config,
            )
        )
        await session.commit()


async def test_another_tenants_bot_account_is_refused_without_naming_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    incumbent = await _tenant(session_factory)
    newcomer = await _tenant(session_factory)
    await _bridge(
        session_factory,
        tenant_id=incumbent,
        connection_config=_MATRIX,
        display_name="Their Matrix",
    )

    with tenant_scope(newcomer):
        with pytest.raises(BridgeClaimConflict, match="already claimed") as raised:
            # The same account under another token is the same account.
            await _service(session_factory).reject_claim_conflict(
                "matrix", {**_MATRIX, "access_token": "syt_other_placeholder"}
            )
    assert "Their Matrix" not in str(raised.value)
    assert "Matrix account @switch-bot:example.org" in str(raised.value)


async def test_a_second_connection_in_the_same_tenant_names_the_first(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant = await _tenant(session_factory)
    await _bridge(
        session_factory,
        tenant_id=tenant,
        connection_config=_MATRIX,
        display_name="Our Matrix",
    )

    with tenant_scope(tenant):
        with pytest.raises(BridgeClaimConflict, match="'Our Matrix'"):
            await _service(session_factory).reject_claim_conflict(
                "matrix", {**_MATRIX, "bot_user_id": "@Switch-Bot:example.org"}
            )


async def test_another_bot_account_is_accepted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    incumbent = await _tenant(session_factory)
    newcomer = await _tenant(session_factory)
    await _bridge(session_factory, tenant_id=incumbent, connection_config=_MATRIX)

    with tenant_scope(newcomer):
        await _service(session_factory).reject_claim_conflict(
            "matrix", {**_MATRIX, "bot_user_id": "@other-bot:example.org"}
        )


async def test_an_edit_onto_a_claimed_account_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    incumbent = await _tenant(session_factory)
    newcomer = await _tenant(session_factory)
    await _bridge(session_factory, tenant_id=incumbent, connection_config=_MATRIX)

    with (
        tenant_scope(newcomer),
        patch.object(MatrixAdapter, "verify_credentials", AsyncMock()),
    ):
        with pytest.raises(BridgeClaimConflict, match="already claimed"):
            await _service(session_factory).check_edited_connection_config(
                bridge_id="the-edited-bridge",
                bridge_type="matrix",
                connection_config=dict(_MATRIX),
            )
