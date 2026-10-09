"""Switch Trust's one server-global settings row — deployment-operator only.

Against real Postgres: a non-operator is refused on every route, the API key
is never echoed back, and a PUT that omits it leaves the stored one alone.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, TenantMember, User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.schemas import TrustSettingsUpdateRequest
from switch_core.gateway.trust_settings import router as trust_settings_router
from switch_core.keys import Keyring

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)

_CONFIGURED_BODY = {
    "endpoint": "https://trust.example",
    "policy_id": "pol_123",
    "api_key": "s3cr3t-key",
}


def _app(session_factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(trust_settings_router)
    app.dependency_overrides[gw_deps.get_session] = _session
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING, gateway_tenant_choice_enabled=False
    )
    return app


async def _add_user(
    session_factory: async_sessionmaker[AsyncSession], *, name: str, role: str
) -> User:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.com", role=role)
        session.add(user)
        await session.flush()
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member")
        )
        await session.commit()
        return user


def _cookies_for(user: User) -> dict[str, str]:
    return {
        "switch_auth": create_jwt(
            user.id, user.email, user.role, TEST_KEYRING, TENANT_ZERO_ID
        )
    }


def _client(
    session_factory: async_sessionmaker[AsyncSession], user: User
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory)),
        base_url="http://test",
        cookies=_cookies_for(user),
    )


async def test_a_non_admin_is_refused_every_route(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user = await _add_user(session_factory, name="mallory", role="user")
    async with _client(session_factory, user) as client:
        get_resp = await client.get("/trust-settings")
        put_resp = await client.put("/trust-settings", json=_CONFIGURED_BODY)
        delete_resp = await client.delete("/trust-settings")

    assert get_resp.status_code == 403
    assert put_resp.status_code == 403
    assert delete_resp.status_code == 403


async def test_get_with_no_row_reports_off_with_the_default_endpoint(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _add_user(session_factory, name="op", role="admin")
    async with _client(session_factory, admin) as client:
        resp = await client.get("/trust-settings")

    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is False
    assert body["has_api_key"] is False
    assert body["api_key_last4"] is None
    assert body["endpoint"] == "https://api.switchagents.ai"


async def test_put_then_get_round_trips_without_exposing_the_key(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _add_user(session_factory, name="op", role="admin")
    async with _client(session_factory, admin) as client:
        put_resp = await client.put("/trust-settings", json=_CONFIGURED_BODY)
        assert put_resp.status_code == 200
        body = put_resp.json()
        assert body["enabled"] is True
        assert body["has_api_key"] is True
        assert body["api_key_last4"] == "-key"
        assert "api_key" not in body

        get_resp = await client.get("/trust-settings")
        assert get_resp.json() == body


async def test_put_without_api_key_leaves_the_stored_key_untouched(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _add_user(session_factory, name="op", role="admin")
    async with _client(session_factory, admin) as client:
        await client.put("/trust-settings", json=_CONFIGURED_BODY)
        resp = await client.put(
            "/trust-settings",
            json={
                "endpoint": "https://trust2.example",
                "policy_id": "pol_123",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["endpoint"] == "https://trust2.example"
    assert body["has_api_key"] is True
    assert body["api_key_last4"] == "-key"


async def test_delete_turns_it_off(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _add_user(session_factory, name="op", role="admin")
    async with _client(session_factory, admin) as client:
        await client.put("/trust-settings", json=_CONFIGURED_BODY)
        delete_resp = await client.delete("/trust-settings")
        get_resp = await client.get("/trust-settings")

    assert delete_resp.status_code == 200
    assert delete_resp.json()["enabled"] is False
    assert get_resp.json()["enabled"] is False


def test_a_blank_policy_id_is_treated_as_unset() -> None:
    req = TrustSettingsUpdateRequest(endpoint="https://trust.example", policy_id="  ")
    assert req.policy_id is None


def test_a_blank_api_key_is_refused_rather_than_silently_stored() -> None:
    with pytest.raises(ValidationError):
        TrustSettingsUpdateRequest(
            endpoint="https://trust.example",
            policy_id="pol_1",
            api_key="   ",
        )


@pytest.mark.parametrize(
    "endpoint,match",
    [
        ("https://trust.example/guardrails/check", "no path"),
        ("not-a-url", "http"),
        (" https://trust.example", "whitespace"),
        ("https://trust.example?x=1", "query"),
    ],
)
def test_endpoint_shape_is_validated(endpoint: str, match: str) -> None:
    with pytest.raises(ValidationError, match=match):
        TrustSettingsUpdateRequest(endpoint=endpoint, policy_id="pol_1")
