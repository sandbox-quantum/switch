"""User linked identities (GET /auth/me/identities) filters retired Mattermost bridges."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt, hash_password
from switch_core.gateway.auth_routes import router
from switch_core.keys import Keyring

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)

_USER_STORE = UserStore()
_BRIDGE_STORE = CollaborationBridgeStore()
_EXTERNAL_USER_STORE = ExternalUserStore()


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: _USER_STORE
    app.dependency_overrides[gw_deps.get_bridge_store] = lambda: _BRIDGE_STORE
    app.dependency_overrides[gw_deps.get_external_user_store] = lambda: (
        _EXTERNAL_USER_STORE
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
    )
    return app


async def _seed_user(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> str:
    async with session_factory() as session:
        user = User(
            name="Test User",
            email=email,
            role="user",
            password_hash=hash_password("password"),
        )
        await _USER_STORE.create(session, user)
        await session.commit()
        return user.id


async def _seed_bridge(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_type: str,
    status: str,
    display_name: str,
) -> str:
    async with session_factory() as session:
        import uuid

        client = Client(
            tenant_id=TENANT_ZERO_ID,
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
            type="bridge",
            display_name=display_name,
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=TENANT_ZERO_ID,
            type=bridge_type,
            status=status,
            display_name=display_name,
            client_id=client.id,
            connection_config={},
            agent_greetings_enabled=True,
            channel_creation_enabled=False,
            preconfigured=False,
        )
        await _BRIDGE_STORE.create(session, bridge)
        await session.commit()
        return bridge.id


async def _seed_external_user(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    user_id: str,
    external_user_id: str,
    external_username: str,
) -> str:
    async with session_factory() as session:
        import uuid

        client = Client(
            tenant_id=TENANT_ZERO_ID,
            transport_user_id=f"@user-{uuid.uuid4().hex[:12]}:test",
            type="user",
            display_name=external_username,
        )
        session.add(client)
        await session.flush()
        external_user = ExternalUser(
            tenant_id=TENANT_ZERO_ID,
            bridge_id=bridge_id,
            external_user_id=external_user_id,
            external_username=external_username,
            client_id=client.id,
        )
        await _EXTERNAL_USER_STORE.create(session, external_user)
        await _EXTERNAL_USER_STORE.claim(session, external_user, user_id)
        await session.commit()
        return external_user.id


def _client(app: FastAPI, user_id: str, email: str) -> httpx.AsyncClient:
    token = create_jwt(user_id, email, "user", _KEYRING, TENANT_ZERO_ID)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def test_retired_mattermost_bridges_are_filtered_out(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A user with identities on retired Mattermost bridges should not see them."""
    email = "user@example.invalid"
    user_id = await _seed_user(session_factory, email)

    # Active Slack bridge
    slack_bridge_id = await _seed_bridge(
        session_factory, "slack", "active", "Slack Workspace"
    )
    # Retired Mattermost bridge
    mattermost_bridge_id = await _seed_bridge(
        session_factory, "mattermost", "retiring", "Mattermost Server"
    )
    # Active Discord bridge
    discord_bridge_id = await _seed_bridge(
        session_factory, "discord", "active", "Discord Server"
    )

    # Link identities on all three bridges
    await _seed_external_user(
        session_factory, slack_bridge_id, user_id, "U123", "@alice"
    )
    await _seed_external_user(
        session_factory, mattermost_bridge_id, user_id, "mm123", "@alice_mm"
    )
    await _seed_external_user(
        session_factory, discord_bridge_id, user_id, "d123", "@alice#1234"
    )

    app = _app(session_factory)
    async with _client(app, user_id, email) as client:
        response = await client.get("/auth/me/identities")

    assert response.status_code == 200
    identities = response.json()

    # Should only see Slack and Discord, not the retired Mattermost
    assert len(identities) == 2
    bridge_types = {i["bridge_type"] for i in identities}
    assert bridge_types == {"slack", "discord"}
    assert "mattermost" not in bridge_types


async def test_active_mattermost_bridges_are_included(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An active Mattermost bridge should still be shown."""
    email = "user2@example.invalid"
    user_id = await _seed_user(session_factory, email)

    # Active Mattermost bridge
    mattermost_bridge_id = await _seed_bridge(
        session_factory, "mattermost", "active", "Mattermost Server"
    )

    await _seed_external_user(
        session_factory, mattermost_bridge_id, user_id, "mm456", "@bob"
    )

    app = _app(session_factory)
    async with _client(app, user_id, email) as client:
        response = await client.get("/auth/me/identities")

    assert response.status_code == 200
    identities = response.json()

    # Active Mattermost should be included
    assert len(identities) == 1
    assert identities[0]["bridge_type"] == "mattermost"


async def test_inactive_mattermost_bridges_are_filtered_out(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An inactive Mattermost bridge should not be shown."""
    email = "user3@example.invalid"
    user_id = await _seed_user(session_factory, email)

    # Inactive Mattermost bridge
    mattermost_bridge_id = await _seed_bridge(
        session_factory, "mattermost", "inactive", "Mattermost Server"
    )

    await _seed_external_user(
        session_factory, mattermost_bridge_id, user_id, "mm789", "@charlie"
    )

    app = _app(session_factory)
    async with _client(app, user_id, email) as client:
        response = await client.get("/auth/me/identities")

    assert response.status_code == 200
    identities = response.json()

    # Inactive Mattermost should be filtered out
    assert len(identities) == 0


async def test_other_platform_inactive_bridges_are_included(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Inactive bridges of non-Mattermost platforms should still be shown."""
    email = "user4@example.invalid"
    user_id = await _seed_user(session_factory, email)

    # Inactive Slack bridge
    slack_bridge_id = await _seed_bridge(
        session_factory, "slack", "inactive", "Slack Workspace"
    )

    await _seed_external_user(
        session_factory, slack_bridge_id, user_id, "U999", "@dave"
    )

    app = _app(session_factory)
    async with _client(app, user_id, email) as client:
        response = await client.get("/auth/me/identities")

    assert response.status_code == 200
    identities = response.json()

    # Inactive Slack should still be included (only Mattermost is filtered)
    assert len(identities) == 1
    assert identities[0]["bridge_type"] == "slack"
