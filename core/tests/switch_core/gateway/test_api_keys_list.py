"""`GET /api-keys` reports a hash prefix, and says so in the field name.

The listing never has the API key itself — only its SHA-256 hash — so the
truncated value it returns cannot be matched against a key an operator holds.
The field is named `key_hash_prefix` for that reason, and this test pins the
name: calling it `key_prefix` is what made the UI claim something false.

Stubs the store rather than driving Postgres; the endpoint does nothing but
project stored rows onto the response schema, so there is no session/commit
behaviour here worth a real database.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.api_keys import router
from switch_core.gateway.auth import get_current_user

_KEY_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


class _StubApiKeyStore:
    async def get_by_user(self, session, user_id):  # noqa: ANN001, ARG002
        return [
            SimpleNamespace(
                id="key-1",
                label="laptop",
                type="agent",
                key_hash=_KEY_HASH,
                created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
        ]


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[gw_deps.get_session] = lambda: None
    app.dependency_overrides[gw_deps.get_api_key_store] = _StubApiKeyStore
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="user-1")
    return app


@pytest.mark.asyncio
async def test_list_api_keys_returns_key_hash_prefix() -> None:
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/")

    assert response.status_code == 200
    (row,) = response.json()
    assert row["key_hash_prefix"] == _KEY_HASH[:12]
    assert "key_prefix" not in row
