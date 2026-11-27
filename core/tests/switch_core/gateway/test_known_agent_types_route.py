"""`GET /agents/known-types` answers only a signed-in caller, like the rest
of `/agents`."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.feature_flags import KNOWN_FEATURE_FLAGS
from switch_core.gateway.agents import router
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.keys import Keyring

pytestmark = pytest.mark.no_ambient_tenant

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)


def _app(session_factory) -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/agents")

    async def sessions():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_user_store] = UserStore
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING,
        feature_flags={flag: False for flag in KNOWN_FEATURE_FLAGS},
    )
    return app


async def _get(app: FastAPI) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        return await client.get("/agents/known-types")


async def test_without_a_session_it_is_refused(session_factory) -> None:
    response = await _get(_app(session_factory))
    assert response.status_code == 401


async def test_a_signed_in_caller_gets_the_types(session_factory) -> None:
    app = _app(session_factory)
    app.dependency_overrides[get_current_user] = lambda: User(
        id="user-1", name="Ada", email="ada@example.com", role="user"
    )
    response = await _get(app)
    assert response.status_code == 200, response.text
    assert "claude-code" in {entry["key"] for entry in response.json()}
