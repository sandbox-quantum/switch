"""An organization's Switch Trust routes, against Postgres and a stand-in for
Switch Trust.

Only the organization's `org_admin`s reach them; a policy is connected only
once Switch Trust answered the check made with it; the key is never echoed or
recorded; each change reaches every process and lands in the organization's
audit log. The old server-wide routes say where the setting went.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    OrganizationAuditEvent,
    OrganizationMember,
    OrganizationTrustSettings,
    TenantMember,
    User,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.organization_guardrails import (
    router as organization_guardrails_router,
)
from switch_core.gateway.trust_settings import SET_PER_ORGANIZATION
from switch_core.gateway.trust_settings import router as trust_settings_router
from switch_core.keys import Keyring
from switch_core.trust.client import (
    GuardrailsCheckError,
    GuardrailsRefusedError,
    TrustCheckResult,
)
from switch_core.trust.workspace_policy import DEFAULT_TRUST_ENDPOINT

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
GUARDRAILS = "/organizations/current/guardrails"
_BODY = {"policy_id": "pol_123", "api_key": "made-up-6789"}


class _SwitchTrust:
    """Answers the connection check as told, and records what it was asked."""

    def __init__(self) -> None:
        self.asked: list[dict[str, str]] = []
        self.refusal: GuardrailsCheckError | None = None
        self.policy_name: str | None = "Baseline Monitoring (Alert)"

    async def __call__(
        self, *, endpoint: str, policy_id: str, api_key: str
    ) -> TrustCheckResult:
        self.asked.append(
            {"endpoint": endpoint, "policy_id": policy_id, "api_key": api_key}
        )
        if self.refusal is not None:
            raise self.refusal
        return TrustCheckResult(
            outcome="ok", policy_id=policy_id, policy_name=self.policy_name
        )


class _World:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory
        self.switch_trust = _SwitchTrust()
        self.changed: list[str] = []

    def app(self) -> FastAPI:
        session_factory = self.session_factory

        async def _session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app = FastAPI()
        app.include_router(organization_guardrails_router)
        app.include_router(trust_settings_router)
        app.dependency_overrides[gw_deps.get_session] = _session
        app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
        app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
        app.dependency_overrides[gw_deps.get_organization_store] = lambda: (
            OrganizationStore()
        )
        app.dependency_overrides[gw_deps.get_trust_connection_check] = lambda: (
            self.switch_trust
        )
        app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
            keyring=TEST_KEYRING, gateway_tenant_choice_enabled=False
        )
        return app

    def client(self, user: User) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app()),
            base_url="http://test",
            cookies={
                "switch_auth": create_jwt(
                    user.id,
                    user.email,
                    user.role,
                    TEST_KEYRING,
                    TENANT_ZERO_ID,
                    session_version=0,
                    auth_time=datetime.now(UTC),
                )
            },
        )

    async def user(
        self,
        name: str,
        *,
        role: str = "user",
        member_role: str = "member",
        organization_role: str | None = None,
    ) -> User:
        async with self.session_factory() as session:
            user = User(name=name, email=f"{name}@example.com", role=role)
            session.add(user)
            await session.flush()
            session.add(
                TenantMember(
                    tenant_id=TENANT_ZERO_ID, user_id=user.id, role=member_role
                )
            )
            if organization_role is not None:
                session.add(
                    OrganizationMember(
                        organization_id=TENANT_ZERO_ID,
                        user_id=user.id,
                        role=organization_role,
                    )
                )
            await session.commit()
            return user

    async def org_admin(self, name: str = "olga") -> User:
        return await self.user(name, organization_role="org_admin")

    async def settings(self) -> list[OrganizationTrustSettings]:
        async with self.session_factory() as session:
            return list(await session.scalars(select(OrganizationTrustSettings)))

    async def audit(self) -> list[OrganizationAuditEvent]:
        async with self.session_factory() as session:
            return list(
                await session.scalars(
                    select(OrganizationAuditEvent)
                    .where(
                        OrganizationAuditEvent.action.like("organization.guardrails%")
                    )
                    .order_by(OrganizationAuditEvent.occurred_at)
                )
            )


@pytest.fixture
def world(session_factory, monkeypatch: pytest.MonkeyPatch) -> _World:
    world = _World(session_factory)
    monkeypatch.setitem(gw_deps._state, "trust_settings_changed", world.changed.append)
    return world


async def test_only_the_organizations_admins_reach_the_routes(world: _World) -> None:
    others = [
        await world.user("wanda", member_role="admin"),
        await world.user("max"),
        await world.user("otto", role="admin"),
    ]
    for someone in others:
        async with world.client(someone) as client:
            answers = [
                (await client.get(GUARDRAILS)).status_code,
                (await client.put(GUARDRAILS, json=_BODY)).status_code,
                (await client.delete(GUARDRAILS)).status_code,
            ]
        assert answers == [403, 403, 403], someone.name
    assert world.switch_trust.asked == []


async def test_nothing_is_connected_to_begin_with(world: _World) -> None:
    async with world.client(await world.org_admin()) as client:
        answer = await client.get(GUARDRAILS)

    assert answer.status_code == 200
    assert answer.json() == {
        "connected": False,
        "policy_id": None,
        "policy_name": None,
        "policy_url": None,
        "api_key_last4": None,
        "connected_by_name": None,
        "connected_at": None,
    }


async def test_connecting_checks_the_policy_with_switch_trust_and_keeps_it(
    world: _World,
) -> None:
    admin = await world.org_admin()
    async with world.client(admin) as client:
        answer = await client.put(
            GUARDRAILS, json={"policy_id": " pol_123 ", "api_key": "made-up-6789"}
        )
        read = await client.get(GUARDRAILS)

    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["connected"] is True
    assert body["policy_id"] == "pol_123"
    assert body["policy_name"] == "Baseline Monitoring (Alert)"
    assert body["policy_url"] == (
        "https://app.switchagents.ai/settings/guardrail-policies/pol_123"
    )
    assert body["api_key_last4"] == "6789"
    assert body["connected_by_name"] == "olga"
    assert read.json() == body
    assert "s3cr3t" not in answer.text
    assert world.switch_trust.asked == [
        {
            "endpoint": DEFAULT_TRUST_ENDPOINT,
            "policy_id": "pol_123",
            "api_key": "made-up-6789",
        }
    ]
    [settings] = await world.settings()
    assert settings.organization_id == TENANT_ZERO_ID
    assert settings.api_key_encrypted != "made-up-6789"
    assert TEST_KEYRING.decrypt(settings.api_key_encrypted) == "made-up-6789"
    assert world.changed == [TENANT_ZERO_ID]
    [event] = await world.audit()
    assert event.action == OrganizationAuditAction.GUARDRAILS_CONNECTED
    assert event.actor_user_id == admin.id
    assert event.details == {
        "policy_id": "pol_123",
        "policy_name": "Baseline Monitoring (Alert)",
        "workspace_id": TENANT_ZERO_ID,
    }
    assert "s3cr3t" not in str(event.details)


async def test_a_policy_switch_trust_refuses_is_not_connected(world: _World) -> None:
    world.switch_trust.refusal = GuardrailsRefusedError(
        "POST https://api.switchagents.ai/guardrails/check answered 401", 401
    )
    async with world.client(await world.org_admin()) as client:
        answer = await client.put(GUARDRAILS, json=_BODY)

    assert answer.status_code == 400
    assert (
        "Switch Trust refused this policy ID and API key (HTTP 401)"
        in (answer.json()["detail"])
    )
    assert (await world.settings(), await world.audit(), world.changed) == ([], [], [])


@pytest.mark.parametrize(
    ("refusal", "expected"),
    [
        (
            GuardrailsRefusedError("answered 503", 503),
            "Switch Trust answered with an error (HTTP 503)",
        ),
        (GuardrailsCheckError("connect timeout"), "Couldn't reach Switch Trust"),
    ],
)
async def test_switch_trust_failing_to_answer_connects_nothing(
    world: _World, refusal: GuardrailsCheckError, expected: str
) -> None:
    world.switch_trust.refusal = refusal
    async with world.client(await world.org_admin()) as client:
        answer = await client.put(GUARDRAILS, json=_BODY)

    assert answer.status_code == 502
    assert expected in answer.json()["detail"]
    assert await world.settings() == []


async def test_a_blank_policy_or_key_is_refused_before_switch_trust_is_asked(
    world: _World,
) -> None:
    async with world.client(await world.org_admin()) as client:
        answers = [
            await client.put(GUARDRAILS, json={"policy_id": " ", "api_key": "k"}),
            await client.put(GUARDRAILS, json={"policy_id": "p", "api_key": "  "}),
        ]

    assert [answer.status_code for answer in answers] == [422, 422]
    assert world.switch_trust.asked == []


async def test_replacing_a_policy_copied_from_the_server_keeps_its_address(
    world: _World,
) -> None:
    """A self-hosted Switch Trust named by the server's former setting."""
    admin = await world.org_admin()
    async with world.session_factory() as session:
        session.add(
            OrganizationTrustSettings(
                organization_id=TENANT_ZERO_ID,
                endpoint="https://trust.internal.example",
                policy_id="pol_old",
                api_key_encrypted=TEST_KEYRING.encrypt("old-key"),
            )
        )
        await session.commit()

    async with world.client(admin) as client:
        before = await client.get(GUARDRAILS)
        answer = await client.put(GUARDRAILS, json=_BODY)

    assert before.json()["connected_by_name"] is None
    assert before.json()["policy_url"] is None
    assert answer.status_code == 200, answer.text
    assert world.switch_trust.asked[0]["endpoint"] == "https://trust.internal.example"
    [event] = await world.audit()
    assert event.details["previous_policy_id"] == "pol_old"


async def test_disconnecting_stops_the_checks_once(world: _World) -> None:
    admin = await world.org_admin()
    async with world.client(admin) as client:
        await client.put(GUARDRAILS, json=_BODY)
        first = await client.delete(GUARDRAILS)
        again = await client.delete(GUARDRAILS)

    assert first.status_code == again.status_code == 200
    assert first.json()["connected"] is False
    assert await world.settings() == []
    assert world.changed == [TENANT_ZERO_ID, TENANT_ZERO_ID]
    assert [event.action for event in await world.audit()] == [
        OrganizationAuditAction.GUARDRAILS_CONNECTED,
        OrganizationAuditAction.GUARDRAILS_DISCONNECTED,
    ]


async def test_the_old_server_wide_routes_say_where_the_setting_went(
    world: _World,
) -> None:
    operator = await world.user("otto", role="admin")
    member = await world.user("max")
    async with world.client(operator) as client:
        answers = [
            await client.get("/trust-settings"),
            await client.put("/trust-settings", json={"endpoint": "https://x"}),
            await client.delete("/trust-settings"),
        ]
    async with world.client(member) as client:
        refused = await client.get("/trust-settings")

    assert [answer.status_code for answer in answers] == [410, 410, 410]
    assert {answer.json()["detail"] for answer in answers} == {SET_PER_ORGANIZATION}
    assert refused.status_code == 403
