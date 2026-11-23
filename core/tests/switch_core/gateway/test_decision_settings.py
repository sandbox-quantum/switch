"""A workspace's decision backend, through its routes on real Postgres.

Signed in with real session cookies bound to a workspace: only that
workspace's admins get in, each sees and changes only its own row, the key
never comes back, and the Test button asks a stub decision service.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    DecisionSettings,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.user_store import UserStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.decision_settings import get_decision_client
from switch_core.gateway.decision_settings import router as decision_router
from switch_core.keys import Keyring
from switch_core.outbound import OutboundPolicy

KEYRING = Keyring.parse("test:" + "d" * 40, legacy_secret=None)
TENANT_B = "decision-settings-tenant-b"
SERVER_URL = "http://decision.test/decide"


# A decision service's /health that lists its backends, as the service from
# this release on answers it: the server default on a hosted open model, its
# own self-hosted model, Gemini falling back to Haiku on Bedrock after 1.5 s,
# Haiku on Bedrock and Haiku with a workspace's Anthropic key.
LISTED_HEALTH: dict[str, Any] = {
    "ok": True,
    "backend": "bedrock_openai",
    "model": "open-model-235b",
    "backends": {
        "default": {
            "backend": "bedrock_openai",
            "model": "open-model-235b",
            "label": "Open Model 235B (Bedrock)",
            "threshold": 0.89,
            "fallback": None,
            "is_default": True,
        },
        "bedrock_openai": {
            "backend": "bedrock_openai",
            "model": "open-model-235b",
            "label": "Open Model 235B (Bedrock)",
            "threshold": 0.89,
            "fallback": None,
        },
        "systemone": {
            "backend": "systemone",
            "model": "small-router",
            "label": "Small Router (self-hosted)",
            "threshold": 0.56,
            "fallback": None,
        },
        "gemini_decision": {
            "backend": "gemini_decision",
            "model": "gemini-decision-1",
            "label": "Gemini (gemini-decision-1)",
            "threshold": 0.8,
            "fallback": {"backend": "bedrock", "model": "haiku-model", "after_s": 1.5},
        },
        "bedrock": {
            "backend": "bedrock",
            "model": "haiku-model",
            "label": "Claude Haiku (Bedrock)",
            "threshold": 0.65,
            "fallback": None,
        },
        "anthropic": {
            "backend": "anthropic",
            "model": "haiku-model",
            "label": "Claude Haiku (Anthropic)",
            "threshold": 0.65,
            "fallback": None,
        },
    },
}
# The /health of a decision service older than this release: no `backends`.
UNLISTED_HEALTH: dict[str, Any] = {"ok": True, "backend": "llamacpp", "model": "m"}


class _Service:
    """The decision service behind every URL, recording what it is sent:
    decisions in `calls`, reads of its `/health` (answered with `health` and
    `health_status`) in `health_calls`."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], dict[str, Any]]] = []
        self.status = 200
        self.health: dict[str, Any] = UNLISTED_HEALTH
        self.health_status = 200
        self.health_calls: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/health"):
            self.health_calls.append(str(request.url))
            return httpx.Response(self.health_status, json=self.health)
        self.calls.append(
            (str(request.url), dict(request.headers), json.loads(request.content))
        )
        return httpx.Response(
            self.status,
            json={
                "agent": "deploy-bot",
                "model_choice": "deploy-bot",
                "confidence": 0.88,
                "threshold": 0.6,
                "model": "stub",
                "latency_ms": 4,
            },
        )


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    service: _Service,
    *,
    server_url: str | None = SERVER_URL,
    bedrock: bool = False,
    allowed: str = "10.9.0.0/16",
) -> FastAPI:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    client = DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability(
            enabled=True,
            server=ServerDefault(
                endpoint_url=server_url,
                api_key="server-key" if server_url else None,
                bedrock_enabled=bedrock,
            ),
            store=DecisionSettingsStore(),
        ),
        keyring=KEYRING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(service.handle)),
        # The workspace's endpoints are checked against the policy before the
        # request; the request itself is the stub's.
        guarded_client=httpx.AsyncClient(transport=httpx.MockTransport(service.handle)),
        outbound_policy=OutboundPolicy.parse(allowed),
        timeout_seconds=1.0,
        telemetry=None,
        cache_seconds=60,
    )
    app = FastAPI()
    app.include_router(decision_router)
    app.dependency_overrides[gw_deps.get_session] = _session
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=KEYRING, gateway_tenant_choice_enabled=False
    )
    app.dependency_overrides[get_decision_client] = lambda: client
    app.state.client = client
    return app


async def _person(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
    role: str,
) -> User:
    async with session_factory() as session:
        if tenant_id != TENANT_ZERO_ID and await session.get(Tenant, tenant_id) is None:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.flush()
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role=role))
        await session.commit()
        return user


def _as(app: FastAPI, user: User, tenant_id: str = TENANT_ZERO_ID) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={
            "switch_auth": create_jwt(
                user.id,
                user.email,
                user.role,
                KEYRING,
                tenant_id,
                session_version=0,
                auth_time=datetime.now(UTC),
                session_id=secrets.token_urlsafe(16),
                identity_session=None,
            )
        },
    )


async def _row(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> DecisionSettings | None:
    async with session_factory() as session:
        return await session.scalar(
            select(DecisionSettings).where(DecisionSettings.tenant_id == tenant_id)
        )


@pytest.fixture
def service() -> _Service:
    return _Service()


async def test_a_member_who_is_not_an_admin_is_refused_every_route(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    member = await _person(session_factory, "mallory", role="member")
    async with _as(_app(session_factory, service), member) as client:
        responses = [
            await client.get("/decision-settings"),
            await client.put("/decision-settings", json={"backend": "none"}),
            await client.delete("/decision-settings"),
            await client.post("/decision-settings/test", json={"backend": "default"}),
        ]

    assert [r.status_code for r in responses] == [403, 403, 403, 403]
    assert await _row(session_factory, TENANT_ZERO_ID) is None
    assert service.calls == []


async def test_with_no_row_the_server_default_applies(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service), admin) as client:
        body = (await client.get("/decision-settings")).json()

    assert body == {
        "source": "server_default",
        "effective": {
            "backend": "endpoint",
            "endpoint": SERVER_URL,
            "threshold": None,
            "available": True,
            "reason": None,
        },
        "workspace": None,
        "server_default": {
            "configured": True,
            "endpoint": SERVER_URL,
            "has_api_key": True,
            "info": None,
        },
        "options": {
            "haiku_anthropic": True,
            "haiku_bedrock": False,
            "self_hosted": False,
            "gemini": False,
            "details": {},
            "source": "configuration",
            "note": None,
        },
    }


async def test_no_server_default_offers_no_haiku_and_says_why(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service, server_url=None), admin) as client:
        body = (await client.get("/decision-settings")).json()
        haiku = await client.put(
            "/decision-settings",
            json={
                "backend": "haiku_anthropic",
                "api_key": "fake-key",
            },
        )

    assert body["effective"]["available"] is False
    assert "Message routing" in body["effective"]["reason"]
    assert body["server_default"]["configured"] is False
    assert body["options"] == {
        "haiku_anthropic": False,
        "haiku_bedrock": False,
        "self_hosted": False,
        "gemini": False,
        "details": {},
        "source": "none",
        "note": None,
    }
    assert haiku.status_code == 422


async def test_a_haiku_key_round_trips_as_its_last_four(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service), admin) as client:
        saved = await client.put(
            "/decision-settings",
            json={
                "backend": "haiku_anthropic",
                "api_key": "fake-key-AwcA",
                "threshold": 0.7,
            },
        )
        again = await client.get("/decision-settings")

    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["source"] == "workspace"
    assert body["effective"]["backend"] == "haiku_anthropic"
    workspace = body["workspace"]
    assert workspace["has_api_key"] is True
    assert workspace["api_key_last4"] == "AwcA"
    assert workspace["api_key_unreadable"] is False
    assert workspace["threshold"] == 0.7
    assert "fake-key" not in saved.text
    assert again.json() == body
    row = await _row(session_factory, TENANT_ZERO_ID)
    assert row is not None and row.api_key_encrypted is not None
    assert "AwcA" not in row.api_key_encrypted


async def test_haiku_needs_a_key_new_or_kept_for_the_same_backend(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service), admin) as client:
        missing = await client.put(
            "/decision-settings", json={"backend": "haiku_anthropic"}
        )
        await client.put(
            "/decision-settings",
            json={
                "backend": "endpoint",
                "endpoint": "http://10.9.0.5/decide",
                "api_key": "endpoint-token",
            },
        )
        not_carried = await client.put(
            "/decision-settings", json={"backend": "haiku_anthropic"}
        )
        await client.put(
            "/decision-settings",
            json={"backend": "haiku_anthropic", "api_key": "fake-1234"},
        )
        kept = await client.put(
            "/decision-settings",
            json={"backend": "haiku_anthropic", "threshold": 0.5},
        )
        cleared = await client.put(
            "/decision-settings",
            json={"backend": "haiku_anthropic", "clear_api_key": True},
        )

    assert missing.status_code == 422
    assert not_carried.status_code == 422
    assert kept.status_code == 200
    assert kept.json()["workspace"]["api_key_last4"] == "1234"
    assert cleared.status_code == 422


ENDPOINT_A = "http://10.9.0.5/decide"
ENDPOINT_B = "http://10.9.0.6/decide"


async def test_an_endpoint_key_is_kept_only_for_the_same_url(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service), admin) as client:
        await client.put(
            "/decision-settings",
            json={
                "backend": "endpoint",
                "endpoint": ENDPOINT_A,
                "api_key": "fake-key-EndA",
            },
        )
        same_url = await client.put(
            "/decision-settings",
            json={"backend": "endpoint", "endpoint": ENDPOINT_A, "threshold": 0.5},
        )
        moved = await client.put(
            "/decision-settings", json={"backend": "endpoint", "endpoint": ENDPOINT_B}
        )
        after_moved = await _row(session_factory, TENANT_ZERO_ID)
        moved_keyless = await client.put(
            "/decision-settings",
            json={"backend": "endpoint", "endpoint": ENDPOINT_B, "clear_api_key": True},
        )
        moved_with_key = await client.put(
            "/decision-settings",
            json={
                "backend": "endpoint",
                "endpoint": ENDPOINT_A,
                "api_key": "fake-key-NewA",
            },
        )

    assert same_url.status_code == 200
    assert same_url.json()["workspace"]["api_key_last4"] == "EndA"
    assert moved.status_code == 422
    assert "endpoint changed" in moved.json()["detail"]
    assert after_moved is not None
    assert after_moved.endpoint == ENDPOINT_A
    assert KEYRING.decrypt(after_moved.api_key_encrypted or "") == "fake-key-EndA"
    assert moved_keyless.status_code == 200
    assert moved_keyless.json()["workspace"]["endpoint"] == ENDPOINT_B
    assert moved_keyless.json()["workspace"]["has_api_key"] is False
    assert moved_with_key.status_code == 200
    assert moved_with_key.json()["workspace"]["api_key_last4"] == "NewA"
    assert service.calls == []


@pytest.mark.parametrize(
    "body",
    [
        {"backend": "none", "threshold": 1.5},
        {"backend": "none", "threshold": -0.1},
        {"backend": "endpoint", "endpoint": "ftp://10.9.0.5/decide"},
        {"backend": "endpoint"},
        {"backend": "endpoint", "endpoint": "http://10.9.0.5", "api_key": " "},
        {"backend": "default"},
        {"backend": "somewhere"},
    ],
)
async def test_bad_values_are_refused_and_the_setting_stays(
    session_factory: async_sessionmaker[AsyncSession],
    service: _Service,
    body: dict[str, Any],
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service), admin) as client:
        await client.put("/decision-settings", json={"backend": "none"})
        refused = await client.put("/decision-settings", json=body)

    assert refused.status_code == 422
    row = await _row(session_factory, TENANT_ZERO_ID)
    assert row is not None and row.backend == "none" and row.threshold is None


async def test_bedrock_is_refused_unless_the_server_allows_it(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    async with _as(_app(session_factory, service), admin) as client:
        refused = await client.put(
            "/decision-settings", json={"backend": "haiku_bedrock"}
        )
    async with _as(_app(session_factory, service, bedrock=True), admin) as client:
        allowed = await client.put(
            "/decision-settings",
            json={"backend": "haiku_bedrock", "api_key": "not-stored"},
        )

    assert refused.status_code == 422
    assert "DECISION_BEDROCK_ENABLED" in refused.json()["detail"]
    assert allowed.status_code == 200
    assert allowed.json()["options"]["haiku_bedrock"] is True
    assert allowed.json()["workspace"]["has_api_key"] is False


async def test_a_key_the_server_cannot_decrypt_still_loads(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    lost = Keyring.parse("gone:" + "g" * 40, legacy_secret=None)
    async with session_factory() as session:
        await DecisionSettingsStore().save(
            session,
            TENANT_ZERO_ID,
            backend="endpoint",
            endpoint="http://10.9.0.5/decide",
            api_key_encrypted=lost.encrypt("lost-token"),
            threshold=None,
        )
        await session.commit()

    async with _as(_app(session_factory, service), admin) as client:
        loaded = await client.get("/decision-settings")
        replaced = await client.put(
            "/decision-settings",
            json={
                "backend": "endpoint",
                "endpoint": "http://10.9.0.5/decide",
                "api_key": "new-token",
            },
        )

    assert loaded.status_code == 200
    workspace = loaded.json()["workspace"]
    assert workspace["has_api_key"] is True
    assert workspace["api_key_unreadable"] is True
    assert workspace["api_key_last4"] is None
    assert replaced.json()["workspace"]["api_key_last4"] == "oken"


async def test_delete_returns_the_workspace_to_the_server_default(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="admin")
    app = _app(session_factory, service)
    async with _as(app, admin) as client:
        await client.put("/decision-settings", json={"backend": "none"})
        async with session_factory() as session:
            assert not await app.state.client.available(session, TENANT_ZERO_ID)
        deleted = await client.delete("/decision-settings")
        body = (await client.get("/decision-settings")).json()

    assert deleted.status_code == 204
    assert body["source"] == "server_default" and body["workspace"] is None
    assert await _row(session_factory, TENANT_ZERO_ID) is None
    # The save dropped the process's cached setting, so it applies at once.
    async with session_factory() as session:
        assert await app.state.client.available(session, TENANT_ZERO_ID)


async def test_another_workspaces_admin_neither_reads_nor_changes_it(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin_a = await _person(session_factory, "ada", role="admin")
    admin_b = await _person(session_factory, "bea", tenant_id=TENANT_B, role="admin")
    app = _app(session_factory, service)
    async with _as(app, admin_a) as client:
        await client.put(
            "/decision-settings",
            json={"backend": "haiku_anthropic", "api_key": "fake-key-AAAA"},
        )

    async with _as(app, admin_b, TENANT_B) as client:
        own = (await client.get("/decision-settings")).json()
        await client.put("/decision-settings", json={"backend": "none"})
        await client.delete("/decision-settings")
    async with _as(app, admin_b, TENANT_ZERO_ID) as client:
        forged = [
            await client.get("/decision-settings"),
            await client.put("/decision-settings", json={"backend": "none"}),
            await client.delete("/decision-settings"),
        ]

    assert own["workspace"] is None and own["source"] == "server_default"
    assert "AAAA" not in json.dumps(own)
    assert [r.status_code for r in forged] == [403, 403, 403]
    assert all("AAAA" not in r.text for r in forged)
    row = await _row(session_factory, TENANT_ZERO_ID)
    assert row is not None and row.backend == "haiku_anthropic"
    assert await _row(session_factory, TENANT_B) is None


class TestTheTestButton:
    async def test_unsaved_values_are_tried_and_nothing_is_saved(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service), admin) as client:
            tried = await client.post(
                "/decision-settings/test",
                json={
                    "backend": "endpoint",
                    "endpoint": "http://10.9.0.5/decide",
                    "api_key": "own-token",
                },
            )

        assert tried.status_code == 200
        body = tried.json()
        assert body["ok"] is True
        assert body["agent"] == "deploy-bot"
        assert body["confidence"] == 0.88
        assert isinstance(body["latency_ms"], int)
        assert body["error"] is None
        [(url, headers, _)] = service.calls
        assert url == "http://10.9.0.5/decide"
        assert headers["authorization"] == "Bearer own-token"
        assert await _row(session_factory, TENANT_ZERO_ID) is None

    async def test_an_omitted_key_is_the_stored_one(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service), admin) as client:
            await client.put(
                "/decision-settings",
                json={"backend": "haiku_anthropic", "api_key": "fake-key-SAVD"},
            )
            await client.post(
                "/decision-settings/test", json={"backend": "haiku_anthropic"}
            )

        [(url, headers, _)] = service.calls
        assert url == SERVER_URL
        assert headers["x-decision-backend"] == "anthropic"
        assert headers["x-decision-anthropic-key"] == "fake-key-SAVD"

    async def test_the_stored_endpoint_key_is_used_for_its_own_url(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service), admin) as client:
            await client.put(
                "/decision-settings",
                json={
                    "backend": "endpoint",
                    "endpoint": ENDPOINT_A,
                    "api_key": "fake-key-EndA",
                },
            )
            tried = await client.post(
                "/decision-settings/test",
                json={"backend": "endpoint", "endpoint": ENDPOINT_A},
            )

        assert tried.json()["ok"] is True
        [(url, headers, _)] = service.calls
        assert url == ENDPOINT_A
        assert headers["authorization"] == "Bearer fake-key-EndA"

    async def test_another_url_asks_for_a_key_and_sends_nothing(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service), admin) as client:
            await client.put(
                "/decision-settings",
                json={
                    "backend": "endpoint",
                    "endpoint": ENDPOINT_A,
                    "api_key": "fake-key-EndA",
                },
            )
            moved = await client.post(
                "/decision-settings/test",
                json={"backend": "endpoint", "endpoint": ENDPOINT_B},
            )
            keyless = await client.post(
                "/decision-settings/test",
                json={
                    "backend": "endpoint",
                    "endpoint": ENDPOINT_B,
                    "clear_api_key": True,
                },
            )

        assert moved.status_code == 200
        assert moved.json()["ok"] is False
        assert moved.json()["error"]["code"] == "not_configured"
        assert "Enter the new endpoint's key" in moved.json()["error"]["message"]
        # Only the keyless try reached the new URL, and it carried no key.
        [(url, headers, _)] = service.calls
        assert keyless.json()["ok"] is True
        assert url == ENDPOINT_B
        assert "authorization" not in headers
        assert "fake-key-EndA" not in json.dumps(headers)

    async def test_default_uses_the_servers_key_never_the_workspaces(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service), admin) as client:
            await client.put(
                "/decision-settings",
                json={
                    "backend": "endpoint",
                    "endpoint": "http://10.9.0.5/decide",
                    "api_key": "workspace-token",
                },
            )
            tried = await client.post(
                "/decision-settings/test",
                json={"backend": "default", "api_key": "workspace-token"},
            )

        assert tried.json()["ok"] is True
        [(url, headers, _)] = service.calls
        assert url == SERVER_URL
        assert headers["authorization"] == "Bearer server-key"
        assert "workspace-token" not in json.dumps(headers)

    async def test_a_refused_key_is_classified(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.status = 401
        async with _as(_app(session_factory, service), admin) as client:
            tried = await client.post(
                "/decision-settings/test",
                json={"backend": "endpoint", "endpoint": "http://10.9.0.5/decide"},
            )

        body = tried.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "unauthorized"
        assert body["error"]["message"]

    async def test_nothing_to_test_is_not_configured(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(
            _app(session_factory, service, server_url=None), admin
        ) as client:
            default = await client.post(
                "/decision-settings/test", json={"backend": "default"}
            )
            none = await client.post(
                "/decision-settings/test", json={"backend": "none"}
            )

        assert default.json()["error"]["code"] == "not_configured"
        assert none.json()["error"]["code"] == "not_configured"
        assert service.calls == []


class TestTheOutboundPolicy:
    @pytest.mark.parametrize("allowed", ["", "169.254.0.0/16"])
    async def test_a_metadata_address_is_always_refused(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        service: _Service,
        allowed: str,
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(
            _app(session_factory, service, allowed=allowed), admin
        ) as client:
            refused = await client.put(
                "/decision-settings",
                json={"backend": "endpoint", "endpoint": "http://169.254.169.254/"},
            )

        assert refused.status_code == 422
        assert "OUTBOUND_ALLOWED_PRIVATE_HOSTS" in refused.json()["detail"]
        assert await _row(session_factory, TENANT_ZERO_ID) is None

    async def test_a_private_address_needs_the_operators_listing(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        body = {"backend": "endpoint", "endpoint": "http://10.0.0.5:8230"}
        async with _as(_app(session_factory, service, allowed=""), admin) as client:
            refused = await client.put("/decision-settings", json=body)
        async with _as(
            _app(session_factory, service, allowed="10.0.0.5"), admin
        ) as client:
            allowed = await client.put("/decision-settings", json=body)

        assert refused.status_code == 422
        assert "OUTBOUND_ALLOWED_PRIVATE_HOSTS" in refused.json()["detail"]
        assert allowed.status_code == 200
        assert allowed.json()["workspace"]["endpoint"] == "http://10.0.0.5:8230"

    async def test_testing_a_refused_address_is_refused_and_not_sent(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service, allowed=""), admin) as client:
            tried = await client.post(
                "/decision-settings/test",
                json={"backend": "endpoint", "endpoint": "http://10.0.0.5:8230"},
            )

        body = tried.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "refused"
        assert "OUTBOUND_ALLOWED_PRIVATE_HOSTS" in body["error"]["message"]
        assert service.calls == []

    async def test_the_server_default_at_a_private_address_is_not_checked(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        app = _app(
            session_factory,
            service,
            server_url="http://10.1.2.3:8230",
            allowed="",
        )
        async with _as(app, admin) as client:
            tried = await client.post(
                "/decision-settings/test", json={"backend": "default"}
            )

        assert tried.json()["ok"] is True
        [(url, _, _)] = service.calls
        assert url == "http://10.1.2.3:8230/decide"


class TestOffersFromTheDecisionService:
    """What a workspace may choose, and how it is named, come from the
    service's /health `backends`."""

    async def test_the_server_default_and_each_choice_are_described(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.health = LISTED_HEALTH
        async with _as(_app(session_factory, service), admin) as client:
            body = (await client.get("/decision-settings")).json()

        assert body["server_default"]["info"] == {
            "label": "Open Model 235B (Bedrock)",
            "model": "open-model-235b",
            "threshold": 0.89,
            "fallback": None,
        }
        options = body["options"]
        assert options["source"] == "service" and options["note"] is None
        assert [
            options[choice]
            for choice in ("haiku_anthropic", "haiku_bedrock", "self_hosted", "gemini")
        ] == [True, True, True, True]
        assert options["details"]["self_hosted"] == {
            "label": "Small Router (self-hosted)",
            "model": "small-router",
            "threshold": 0.56,
            "fallback": None,
        }
        assert options["details"]["gemini"]["fallback"] == {
            "backend": "bedrock",
            "model": "haiku-model",
            "label": "Claude Haiku (Bedrock)",
            "after_s": 1.5,
        }
        assert options["details"]["haiku_bedrock"]["threshold"] == 0.65
        assert service.health_calls == ["http://decision.test/health"]

    async def test_a_fallback_the_service_does_not_list_is_named_by_its_model(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        backends = dict(LISTED_HEALTH["backends"])
        del backends["bedrock"]
        service.health = {**LISTED_HEALTH, "backends": backends}
        async with _as(_app(session_factory, service), admin) as client:
            body = (await client.get("/decision-settings")).json()

        assert body["options"]["haiku_bedrock"] is False
        assert (
            body["options"]["details"]["gemini"]["fallback"]["label"] == "haiku-model"
        )

    async def test_the_list_decides_not_decision_bedrock_enabled(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.health = LISTED_HEALTH
        async with _as(_app(session_factory, service, bedrock=False), admin) as client:
            listed = await client.put(
                "/decision-settings", json={"backend": "haiku_bedrock"}
            )
        backends = dict(LISTED_HEALTH["backends"])
        del backends["bedrock"]
        service.health = {**LISTED_HEALTH, "backends": backends}
        async with _as(_app(session_factory, service, bedrock=True), admin) as client:
            unlisted = await client.put(
                "/decision-settings", json={"backend": "haiku_bedrock"}
            )

        assert listed.status_code == 200, listed.text
        assert listed.json()["effective"]["backend"] == "haiku_bedrock"
        assert unlisted.status_code == 422
        assert "doesn't run it" in unlisted.json()["detail"]

    @pytest.mark.parametrize(
        ("backend", "header"),
        [("self_hosted", "systemone"), ("gemini", "gemini_decision")],
    )
    async def test_a_new_choice_saves_without_a_key_and_tests_with_its_backend(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        service: _Service,
        backend: str,
        header: str,
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.health = LISTED_HEALTH
        async with _as(_app(session_factory, service), admin) as client:
            saved = await client.put(
                "/decision-settings",
                json={"backend": backend, "api_key": "not-stored", "threshold": 0.7},
            )
            tried = await client.post(
                "/decision-settings/test", json={"backend": backend}
            )

        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert body["source"] == "workspace"
        assert body["effective"] == {
            "backend": backend,
            "endpoint": None,
            "threshold": 0.7,
            "available": True,
            "reason": None,
        }
        assert body["workspace"]["has_api_key"] is False
        assert body["workspace"]["unrecognized_backend"] is None
        assert tried.json()["ok"] is True
        [(url, headers, sent)] = service.calls
        assert url == SERVER_URL
        assert headers["x-decision-backend"] == header
        assert headers["authorization"] == "Bearer server-key"
        assert "x-decision-anthropic-key" not in headers
        assert "not-stored" not in json.dumps(headers)
        row = await _row(session_factory, TENANT_ZERO_ID)
        assert row is not None and row.backend == backend
        assert row.api_key_encrypted is None

    @pytest.mark.parametrize("backend", ["self_hosted", "gemini"])
    async def test_a_choice_the_service_does_not_run_is_neither_saved_nor_tested(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        service: _Service,
        backend: str,
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.health = {
            **LISTED_HEALTH,
            "backends": {
                name: entry
                for name, entry in LISTED_HEALTH["backends"].items()
                if name not in ("systemone", "gemini_decision")
            },
        }
        async with _as(_app(session_factory, service), admin) as client:
            body = (await client.get("/decision-settings")).json()
            refused = await client.put("/decision-settings", json={"backend": backend})
            tried = await client.post(
                "/decision-settings/test", json={"backend": backend}
            )

        assert body["options"][backend] is False
        assert backend not in body["options"]["details"]
        assert refused.status_code == 422
        assert tried.json()["error"]["code"] == "backend_unavailable"
        assert service.calls == []
        assert await _row(session_factory, TENANT_ZERO_ID) is None

    async def test_an_older_service_offers_neither_new_choice(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        async with _as(_app(session_factory, service, bedrock=True), admin) as client:
            body = (await client.get("/decision-settings")).json()
            refused = await client.put("/decision-settings", json={"backend": "gemini"})

        assert body["options"]["source"] == "configuration"
        assert body["options"]["haiku_bedrock"] is True
        assert body["options"]["self_hosted"] is False
        assert body["options"]["gemini"] is False
        assert refused.status_code == 422
        assert "older" in refused.json()["detail"]

    async def test_an_unreadable_service_offers_only_what_is_saved_and_says_why(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.health = LISTED_HEALTH
        async with _as(_app(session_factory, service), admin) as client:
            await client.put("/decision-settings", json={"backend": "gemini"})
        service.health_status = 503
        async with _as(_app(session_factory, service), admin) as client:
            body = (await client.get("/decision-settings")).json()
            kept = await client.put(
                "/decision-settings", json={"backend": "gemini", "threshold": 0.75}
            )
            refused = await client.put(
                "/decision-settings", json={"backend": "self_hosted"}
            )
            tried = await client.post(
                "/decision-settings/test", json={"backend": "self_hosted"}
            )

        options = body["options"]
        assert options["source"] == "unavailable"
        assert "status 503" in options["note"]
        assert not any(
            options[choice]
            for choice in ("haiku_anthropic", "haiku_bedrock", "self_hosted", "gemini")
        )
        assert body["server_default"]["info"] is None
        assert body["workspace"]["backend"] == "gemini"
        assert body["effective"]["available"] is True
        assert kept.status_code == 200
        assert kept.json()["workspace"]["threshold"] == 0.75
        assert refused.status_code == 422
        assert "status 503" in refused.json()["detail"]
        # A test still runs: it shows for itself whether the backend answers.
        assert tried.json()["ok"] is True
        [(_, headers, _)] = service.calls
        assert headers["x-decision-backend"] == "systemone"

    async def test_an_unreachable_or_garbled_service_is_unavailable(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        garbled = _Service()
        garbled.health = {"backends": {"default": {"label": 3}}}
        async with _as(_app(session_factory, garbled), admin) as client:
            unreadable = (await client.get("/decision-settings")).json()
        unreachable = _app(
            session_factory, garbled, server_url="http://127.0.0.1:9/decide"
        )
        unreachable.dependency_overrides[get_decision_client] = lambda: _offline_client(
            session_factory
        )
        async with _as(unreachable, admin) as client:
            offline = (await client.get("/decision-settings")).json()

        assert unreadable["options"]["source"] == "unavailable"
        assert "something else" in unreadable["options"]["note"]
        assert offline["options"]["source"] == "unavailable"
        assert "could not be reached" in offline["options"]["note"]

    async def test_the_reading_is_cached_briefly(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        admin = await _person(session_factory, "ada", role="admin")
        service.health = LISTED_HEALTH
        async with _as(_app(session_factory, service), admin) as client:
            await client.get("/decision-settings")
            await client.get("/decision-settings")
            await client.put("/decision-settings", json={"backend": "self_hosted"})

        assert len(service.health_calls) == 1


async def test_a_saved_choice_this_release_does_not_know_loads_as_off(
    session_factory: async_sessionmaker[AsyncSession],
    service: _Service,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A newer release wrote it during a rolling deploy, or before a rollback.
    # The CHECK keeps such a value out of this schema, so the store hands it
    # over as the newer schema would.
    admin = await _person(session_factory, "ada", role="admin")

    async def newer_row(
        store: DecisionSettingsStore, session: AsyncSession, tenant_id: str
    ) -> DecisionSettings:
        return DecisionSettings(
            tenant_id=tenant_id,
            backend="from_the_future",
            endpoint=None,
            api_key_encrypted=None,
            threshold=None,
            updated_at=datetime.now(UTC),
        )

    monkeypatch.setattr(DecisionSettingsStore, "get", newer_row)
    async with _as(_app(session_factory, service), admin) as client:
        loaded = await client.get("/decision-settings")

    assert loaded.status_code == 200, loaded.text
    body = loaded.json()
    assert body["workspace"]["backend"] == "none"
    assert body["workspace"]["unrecognized_backend"] == "from_the_future"
    assert body["effective"]["backend"] == "none"
    assert body["effective"]["available"] is False
    assert "doesn't know" in body["effective"]["reason"]


def _offline_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> DynamicDecisionClient:
    """A client whose server decision service refuses every connection."""

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability(
            enabled=True,
            server=ServerDefault(
                endpoint_url=SERVER_URL, api_key="server-key", bedrock_enabled=False
            ),
            store=DecisionSettingsStore(),
        ),
        keyring=KEYRING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
        guarded_client=httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
        outbound_policy=OutboundPolicy.parse(""),
        timeout_seconds=1.0,
        telemetry=None,
        cache_seconds=60,
    )
