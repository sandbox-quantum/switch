"""Controller credentials and enrollment codes are not the user's API keys.

Both are `api_keys` rows owned by the user who enrolled the controller, so
the user's key routes would otherwise list them, offer to reveal them (and
fail to decrypt the empty `encrypted_key` they hold), or let them be deleted
from under agent management. None of the three is allowed.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import ApiKey
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.api_keys import router as api_keys_router
from switch_core.keys import Keyring
from tests.switch_core.management.harness import add_member, cookies_for

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(api_keys_router, prefix="/api-keys")
    app.dependency_overrides[gw_deps.get_session] = _session
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING, gateway_tenant_choice_enabled=False
    )
    return app


@pytest.mark.parametrize("key_type", ["controller", "controller_enrollment"])
async def test_hash_only_keys_are_not_listed_revealed_or_deleted(
    session_factory: async_sessionmaker[AsyncSession], key_type: str
) -> None:
    owner = await add_member(session_factory, "ada")
    async with session_factory() as session:
        hidden = ApiKey(
            user_id=owner.id,
            key_hash="hash-only",
            encrypted_key="",
            label="controller",
            type=key_type,
        )
        visible = ApiKey(
            user_id=owner.id,
            key_hash="registration",
            encrypted_key=TEST_KEYRING.encrypt("plain"),
            label="mine",
            type="registration",
        )
        session.add_all([hidden, visible])
        await session.commit()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(owner),
    ) as client:
        listed = await client.get("/api-keys")
        reveal = await client.get(f"/api-keys/{hidden.id}/reveal")
        delete = await client.delete(f"/api-keys/{hidden.id}")
        reveal_visible = await client.get(f"/api-keys/{visible.id}/reveal")

    assert [k["id"] for k in listed.json()] == [visible.id]
    assert reveal.status_code == 404
    assert delete.status_code == 404
    assert reveal_visible.json() == {"key": "plain"}
    async with session_factory() as session:
        assert await ApiKeyStore().get(session, hidden.id) is not None
