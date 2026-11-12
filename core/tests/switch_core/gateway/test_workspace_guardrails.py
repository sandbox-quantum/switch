"""Anyone in a workspace may read which Switch Trust policy checks its
messages, and where to see it; nobody reads the key it is checked with."""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.trust_settings import DEFAULT_TRUST_ENDPOINT
from switch_core.gateway.workspace_guardrails import router
from tests.switch_core.gateway.test_api_keys_hash_only import TEST_KEYRING
from tests.switch_core.management.harness import add_member, cookies_for


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[gw_deps.get_session] = _session
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING, gateway_tenant_choice_enabled=False
    )
    return app


async def _save(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    endpoint: str = DEFAULT_TRUST_ENDPOINT,
    policy_id: str | None,
    api_key_encrypted: str | None,
) -> None:
    async with session_factory() as session:
        await TrustSettingsStore().upsert(
            session,
            endpoint=endpoint,
            policy_id=policy_id,
            api_key_encrypted=api_key_encrypted,
        )
        await session.commit()


async def _read(
    session_factory: async_sessionmaker[AsyncSession], reader: str = "reader"
) -> httpx.Response:
    member = await add_member(session_factory, reader)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=cookies_for(member),
    ) as client:
        return await client.get("/workspace/guardrails")


async def test_a_member_reads_the_policy_that_checks_the_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _save(session_factory, policy_id="policy/1", api_key_encrypted="sealed-key")

    read = await _read(session_factory)

    assert read.status_code == 200, read.text
    assert read.json() == {
        "checking": True,
        "policy_id": "policy/1",
        "policy_url": "https://app.switchagents.ai/settings/guardrail-policies/policy%2F1",
    }
    assert "sealed-key" not in read.text


async def test_nothing_checks_until_a_policy_and_a_key_are_saved(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    nothing = await _read(session_factory)
    await _save(session_factory, policy_id="policy-1", api_key_encrypted=None)
    no_key = await _read(session_factory, "another-reader")

    for read in (nothing, no_key):
        assert read.status_code == 200, read.text
        assert read.json() == {"checking": False, "policy_id": None, "policy_url": None}


async def test_a_policy_on_another_endpoint_is_not_linked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _save(
        session_factory,
        endpoint="https://guardrails.example.test",
        policy_id="policy-1",
        api_key_encrypted="sealed-key",
    )

    read = await _read(session_factory)

    assert read.json() == {
        "checking": True,
        "policy_id": "policy-1",
        "policy_url": None,
    }
