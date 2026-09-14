from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApiKey, ServerConnector, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.connectors import delete_connector

_USER_STORE = UserStore()


async def _is_admin(session: AsyncSession, user: User) -> bool:
    """The bit `get_tenant_is_admin` hands the route, resolved the same way."""
    return await _USER_STORE.administers(session, user)


class _StubLifecycle:
    """Records remove() calls so we can assert whether deletion happened."""

    def __init__(self) -> None:
        self.removed: list[str] = []

    async def remove(self, connector_id: str) -> None:
        self.removed.append(connector_id)


async def _make_user(session: AsyncSession, *, role: str) -> User:
    user = User(name=f"{role}-user", email=f"{role}-{_uuid_suffix()}@x.test", role=role)
    session.add(user)
    await session.flush()
    return user


_counter = 0


def _uuid_suffix() -> str:
    global _counter
    _counter += 1
    return str(_counter)


async def _make_connector(session: AsyncSession, *, owner: User) -> ServerConnector:
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{_uuid_suffix()}",
        encrypted_key="enc",
        label="server-connector:test",
        type="registration",
    )
    session.add(key)
    await session.flush()

    connector = ServerConnector(
        type="test-type",
        display_name="Test Connector",
        connection_config={},
        api_key_id=key.id,
        status="active",
    )
    session.add(connector)
    await session.flush()
    return connector


class TestDeleteConnectorAuthorization:
    async def test_non_owner_non_admin_is_forbidden(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, role="user")
            other = await _make_user(session, role="user")
            connector = await _make_connector(session, owner=owner)
            await session.commit()

            lifecycle = _StubLifecycle()
            with pytest.raises(HTTPException) as exc:
                await delete_connector(
                    connector_id=connector.id,
                    session=session,
                    connector_store=ServerConnectorStore(),
                    api_key_store=ApiKeyStore(),
                    connector_lifecycle=lifecycle,  # type: ignore[arg-type]
                    user=other,
                    is_admin=await _is_admin(session, other),
                )

            assert exc.value.status_code == 403
            assert lifecycle.removed == []

    async def test_owner_can_delete(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, role="user")
            connector = await _make_connector(session, owner=owner)
            await session.commit()

            lifecycle = _StubLifecycle()
            result = await delete_connector(
                connector_id=connector.id,
                session=session,
                connector_store=ServerConnectorStore(),
                api_key_store=ApiKeyStore(),
                connector_lifecycle=lifecycle,  # type: ignore[arg-type]
                user=owner,
                is_admin=await _is_admin(session, owner),
            )

            assert result == {"ok": True}
            assert lifecycle.removed == [connector.id]

    async def test_admin_can_delete_others_connector(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, role="user")
            admin = await _make_user(session, role="admin")
            connector = await _make_connector(session, owner=owner)
            await session.commit()

            lifecycle = _StubLifecycle()
            result = await delete_connector(
                connector_id=connector.id,
                session=session,
                connector_store=ServerConnectorStore(),
                api_key_store=ApiKeyStore(),
                connector_lifecycle=lifecycle,  # type: ignore[arg-type]
                user=admin,
                is_admin=await _is_admin(session, admin),
            )

            assert result == {"ok": True}
            assert lifecycle.removed == [connector.id]

    async def test_missing_connector_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await _make_user(session, role="user")
            await session.commit()

            lifecycle = _StubLifecycle()
            with pytest.raises(HTTPException) as exc:
                await delete_connector(
                    connector_id="does-not-exist",
                    session=session,
                    connector_store=ServerConnectorStore(),
                    api_key_store=ApiKeyStore(),
                    connector_lifecycle=lifecycle,  # type: ignore[arg-type]
                    user=user,
                    is_admin=await _is_admin(session, user),
                )

            assert exc.value.status_code == 404
            assert lifecycle.removed == []
