"""A workspace's decision backend, through its routes on real Postgres.

Signed in with real session cookies bound to a workspace: only that
workspace's admins get in, each sees and changes only its own row, the key
never comes back, and the Test button asks a stub decision service.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.db.models import (
    TENANT_ZERO_ID,
    DecisionSettings,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.user_store import UserStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.machine import MachineDecisions
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


class _Service:
    """The decision service behind every URL, recording what it is sent."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], dict[str, Any]]] = []
        self.status = 200

    def handle(self, request: httpx.Request) -> httpx.Response:
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
    presence: ControllerPresence | None = None,
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
            controllers=AgentControllerStore(),
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
        machines=MachineDecisions(
            presence
            if presence is not None
            else ControllerPresence(on_bound=lambda _agent_id: None)
        ),
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
                user.id, user.email, user.role, KEYRING, tenant_id
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
            "machine": None,
        },
        "workspace": None,
        "server_default": {
            "configured": True,
            "endpoint": SERVER_URL,
            "has_api_key": True,
        },
        "options": {"haiku_anthropic": True, "haiku_bedrock": False, "machines": []},
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
    assert "Decision routing" in body["effective"]["reason"]
    assert body["server_default"]["configured"] is False
    assert body["options"] == {
        "haiku_anthropic": False,
        "haiku_bedrock": False,
        "machines": [],
    }
    assert haiku.status_code == 422


async def test_a_haiku_key_round_trips_as_its_last_four(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    admin = await _person(session_factory, "ada", role="owner")
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
