"""Asking whether your own account can be deleted (GET /auth/me/deletion).

Against a real database, with the services `test_account_deletion.py` fakes:
the check runs the refusals `DELETE /auth/me` runs, and must answer with the
same sentence the deletion would refuse with, and change nothing.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import get_service_broker
from switch_core.db.models import TENANT_ZERO_ID, CloudMachine, OrganizationMember, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.auth_routes import router
from switch_core.gateway.identity_sessions import IdentitySessions
from switch_core.gateway.invite_mail import InviteMailer
from tests.conftest import TEST_KEYRING
from tests.switch_core.accounts.test_account_deletion import (
    ADMIN_EMAIL,
    _deletion,
    _SignInFlows,
)
from tests.switch_core.gateway.test_organization_admin_notices import (
    SentAfter,
    WatchedMailer,
)
from tests.switch_core.gateway.test_tenant_api_routes import _make_member
from tests.switch_core.pool_checkouts import PoolCheckouts


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    mailer: InviteMailer | None = None,
) -> FastAPI:
    deletion, _, _ = _deletion(session_factory, mailer)

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.state.sign_in_flows = _SignInFlows()
    app.state.identity_sessions = IdentitySessions(session_factory, None)
    overrides = app.dependency_overrides
    overrides[gw_deps.get_session] = _session_dep
    overrides[gw_deps.get_system_session] = _session_dep
    overrides[gw_deps.get_session_factory] = lambda: session_factory
    overrides[gw_deps.get_user_store] = lambda: UserStore()
    overrides[gw_deps.get_organization_store] = lambda: OrganizationStore()
    overrides[gw_deps.get_agent_store] = lambda: AgentStore()
    overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    overrides[gw_deps.get_template_store] = lambda: TemplateStore()
    overrides[gw_deps.get_protocol] = lambda: deletion.protocol
    overrides[gw_deps.get_resource_service] = lambda: deletion.resources
    overrides[gw_deps.get_room_service] = lambda: deletion.rooms
    overrides[get_service_broker] = lambda: deletion.broker
    overrides[gw_deps.get_client_lifecycle] = lambda: deletion.clients
    overrides[gw_deps.get_organization_admin_notices] = lambda: deletion.admin_notices
    overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING,
        gateway_cookie_secure=False,
        gateway_admin_email=ADMIN_EMAIL,
        gateway_tenant_choice_enabled=False,
        dashboard_base_url="https://switch.example.test",
    )
    return app


def _client(app: Any, user_id: str, email: str) -> httpx.AsyncClient:
    token = create_jwt(
        user_id,
        email,
        "user",
        TEST_KEYRING,
        TENANT_ZERO_ID,
        session_version=0,
        session_id=secrets.token_urlsafe(16),
        identity_session=None,
        auth_time=datetime.now(UTC),
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _people(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    """The server's administrator account, and a member beside it."""
    operator = await _make_member(
        session_factory,
        name="operator",
        tenant_id=TENANT_ZERO_ID,
        role="admin",
        email=ADMIN_EMAIL,
        user_role="admin",
    )
    member = await _make_member(
        session_factory, name="leaving", tenant_id=TENANT_ZERO_ID, role="member"
    )
    return operator, member


async def test_a_member_beside_another_admin_may_delete_and_nothing_changes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, member = await _people(session_factory)
    async with _client(
        _app(session_factory), member, "leaving@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    assert response.json() == {"refusal": None}
    async with session_factory() as session:
        assert await session.get(User, member) is not None


async def test_the_only_admin_of_a_shared_workspace_is_told_what_the_deletion_says(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _make_member(
        session_factory, name="colleague", tenant_id=TENANT_ZERO_ID, role="member"
    )
    only_admin = await _make_member(
        session_factory, name="only-admin", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    async with _client(
        _app(session_factory), only_admin, "only-admin@example.invalid"
    ) as client:
        checked = await client.get("/auth/me/deletion")
        deleted = await client.request(
            "DELETE", "/auth/me", json={"email": "only-admin@example.invalid"}
        )
    assert checked.status_code == 200, checked.text
    refusal = checked.json()["refusal"]
    assert refusal is not None and "only admin" in refusal
    assert deleted.status_code == 409, deleted.text
    assert deleted.json()["detail"] == refusal


async def test_the_only_org_admin_is_told_while_others_are_in_the_organization(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    org_admin = await _make_member(
        session_factory, name="org-admin", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    # Another workspace admin, so only the organization's rule refuses.
    colleague = await _make_member(
        session_factory, name="colleague", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    async with session_factory() as session:
        session.add_all(
            [
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID, user_id=org_admin, role="org_admin"
                ),
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID, user_id=colleague, role="member"
                ),
            ]
        )
        await session.commit()
    async with _client(
        _app(session_factory), org_admin, "org-admin@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    refusal = response.json()["refusal"]
    assert refusal is not None and "only organization admin" in refusal


async def test_an_account_with_a_cloud_machine_is_told(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, member = await _people(session_factory)
    async with session_factory() as session:
        session.add(
            CloudMachine(
                id=uuid.uuid4().hex,
                owner_id=member,
                state="ready",
                active_at=datetime.now(UTC),
            )
        )
        await session.commit()
    async with _client(
        _app(session_factory), member, "leaving@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    refusal = response.json()["refusal"]
    assert refusal is not None and "cloud machine" in refusal


async def test_the_operators_account_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator, _ = await _people(session_factory)
    async with _client(_app(session_factory), operator, ADMIN_EMAIL) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    refusal = response.json()["refusal"]
    assert refusal is not None and "administrator account" in refusal


async def test_deleting_an_org_admin_emails_after_the_response_holding_nothing(
    session_factory: async_sessionmaker[AsyncSession],
    pool_checkouts: PoolCheckouts,
) -> None:
    """The organization's admins and the person are e-mailed once the
    account is gone and the response has been sent, with no connection held
    while the relay is talked to."""
    leaving = await _make_member(
        session_factory, name="leaving-admin", tenant_id=TENANT_ZERO_ID, role="member"
    )
    staying = await _make_member(
        session_factory, name="staying-admin", tenant_id=TENANT_ZERO_ID, role="admin"
    )
    async with session_factory() as session:
        session.add_all(
            [
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID, user_id=user_id, role="org_admin"
                )
                for user_id in (leaving, staying)
            ]
        )
        await session.commit()
    response = SentAfter()
    mailer = WatchedMailer(response, pool_checkouts)
    app = pool_checkouts.wrap(response.wrap(_app(session_factory, mailer)))

    async with _client(app, leaving, "leaving-admin@example.invalid") as client:
        deleted = await client.request(
            "DELETE", "/auth/me", json={"email": "leaving-admin@example.invalid"}
        )

    assert deleted.status_code == 200, deleted.text
    assert sorted(mailer.seen) == [
        ("leaving-admin@example.invalid", True, 0),
        ("staying-admin@example.invalid", True, 0),
    ]
    async with session_factory() as session:
        assert await session.get(User, leaving) is None


async def test_another_operator_may_delete_their_own_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _people(session_factory)
    other_operator = await _make_member(
        session_factory,
        name="second-operator",
        tenant_id=TENANT_ZERO_ID,
        role="member",
        user_role="admin",
    )
    async with _client(
        _app(session_factory), other_operator, "second-operator@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    assert response.json() == {"refusal": None}


async def test_the_only_operator_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    only_operator = await _make_member(
        session_factory,
        name="only-operator",
        tenant_id=TENANT_ZERO_ID,
        role="member",
        user_role="admin",
    )
    async with _client(
        _app(session_factory), only_operator, "only-operator@example.invalid"
    ) as client:
        response = await client.get("/auth/me/deletion")
    assert response.status_code == 200, response.text
    refusal = response.json()["refusal"]
    assert refusal is not None and "only platform operator" in refusal
