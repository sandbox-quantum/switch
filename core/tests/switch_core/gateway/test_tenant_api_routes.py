"""The route half of CHOO-2722: `gateway/tenants.py`'s workspace, invitation
and member routes.

Builds route-scoped apps the same way `test_tenant_resolution.py` does —
`switch_core.gateway.dependencies`' functions overridden individually rather
than through `init_dependencies` — so nothing here leaks into another test and
nothing but `switch_core.gateway.tenants` itself is exercised for real.

`_FakeClientLifecycle.create_tenant` mirrors
`ClientLifecycleService.create_tenant`'s DB half (insert the tenant row inside
a `tenant_session` bound to its own id) without the Matrix admin-client
provisioning, which needs a running homeserver these tests have no business
depending on. The unique-slug behaviour under test comes from the same
`tenants.slug` column either way.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_OWNER_MARKER_META_KEY,
)
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.connections.adapters.github import GitHubAdapter
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    AuditEvent,
    Client,
    CollaborationBridge,
    ExternalUser,
    Invitation,
    Message,
    Organization,
    OrganizationMember,
    Room,
    ServiceTokenIssuance,
    SignInFlow,
    Tenant,
    TenantMember,
    UsageMetric,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.erasure_store import ErasureStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.retention_store import RetentionStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    JWT_ALGORITHM,
    SESSION_MAX_AGE,
    create_jwt,
    decode_jwt,
)
from switch_core.gateway.invite_mail import (
    InviteEmail,
    InviteEmailFailed,
    InviteMailer,
)
from switch_core.gateway.tenants import router as tenants_router
from switch_core.keys import Keyring, Purpose
from switch_core.organization_directory import LocalDirectory
from tests.ownership import NeverOwned
from tests.switch_core.statement_counts import StatementCounts

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
_KEYRING = Keyring.parse("test:" + _SECRET, legacy_secret=None)
TENANT_A = "tenant-api-routes-a"
TENANT_B = "tenant-api-routes-b"


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_tenant(self, name: str, slug: str, organization_id: str) -> Tenant:
        tenant = Tenant(
            id=str(uuid.uuid4()), name=name, slug=slug, organization_id=organization_id
        )
        async with tenant_session(self._session_factory, tenant.id) as session:
            await TenantStore().create(session, tenant)
            await session.commit()
        return tenant


class _ProvisioningFailsLifecycle(_FakeClientLifecycle):
    """Commits the tenant, then fails the way a concurrent admin-client insert
    does — an integrity error that has nothing to do with the slug."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.calls = 0

    async def create_tenant(self, name: str, slug: str, organization_id: str) -> Tenant:
        self.calls += 1
        await super().create_tenant(name, slug, organization_id)
        raise IntegrityError("INSERT INTO clients ...", None, Exception("duplicate"))


class _FailsBeforeTheWorkspaceLifecycle(_FakeClientLifecycle):
    """Fails before writing anything, the way a dropped connection does."""

    async def create_tenant(self, name: str, slug: str, organization_id: str) -> Tenant:
        raise ConnectionResetError("connection to the database was lost")


class _RecordingMailer:
    def __init__(self) -> None:
        self.sent: list[InviteEmail] = []

    async def send_invitation(self, invite: InviteEmail) -> None:
        self.sent.append(invite)


class _FailingMailer:
    async def send_invitation(self, invite: InviteEmail) -> None:
        raise InviteEmailFailed("relay refused the message")


def _fake_protocol() -> SimpleNamespace:
    return SimpleNamespace(
        api_key_cache=SimpleNamespace(
            invalidate=lambda key_hash: None,
            invalidate_agent=lambda agent_id: None,
        )
    )


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    client_lifecycle: object | None = None,
    max_workspaces_per_user: int = 3,
    signup_mode: str = "default_tenant",
    mailer: InviteMailer | None = None,
    invite_emails_per_day: int = 50,
) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(tenants_router)
    app.dependency_overrides[gw_deps.get_session] = _session_dep
    app.dependency_overrides[gw_deps.get_system_session] = _session_dep
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: session_factory
    app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    app.dependency_overrides[gw_deps.get_organization_directory] = lambda: (
        LocalDirectory()
    )
    app.dependency_overrides[gw_deps.get_agent_store] = lambda: AgentStore()
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    app.dependency_overrides[gw_deps.get_invitation_store] = lambda: InvitationStore()
    app.dependency_overrides[gw_deps.get_join_domain_store] = lambda: JoinDomainStore()
    app.dependency_overrides[gw_deps.get_organization_store] = lambda: (
        OrganizationStore()
    )
    app.dependency_overrides[gw_deps.get_usage_store] = lambda: UsageStore()
    app.dependency_overrides[gw_deps.get_budget_store] = lambda: BudgetStore()
    app.dependency_overrides[gw_deps.get_retention_store] = lambda: RetentionStore()
    app.dependency_overrides[gw_deps.get_erasure_store] = lambda: ErasureStore()
    app.dependency_overrides[gw_deps.get_protocol] = lambda: _fake_protocol()
    app.dependency_overrides[gw_deps.get_invite_mailer] = lambda: mailer
    app.dependency_overrides[gw_deps.get_client_lifecycle] = lambda: (
        client_lifecycle or _FakeClientLifecycle(session_factory)
    )
    app.state.sign_in_flows = SignInFlows(session_factory, _KEYRING)
    app.state.service_broker = ServiceBroker(
        session_factory=session_factory,
        keyring=_KEYRING,
        catalog=CATALOG,
        adapters={},
        organization_apps=None,
        disabled={},
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_max_workspaces_per_user=max_workspaces_per_user,
        gateway_signup_mode=signup_mode,
        gateway_invite_emails_per_day=invite_emails_per_day,
        dashboard_base_url="https://switch.example.com/",
    )
    return app


def _client(app: FastAPI, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _make_tenant(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()


async def _make_member(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    name: str,
    tenant_id: str,
    role: str,
    email: str | None = None,
    user_role: str = "user",
) -> str:
    """A user with a membership in `tenant_id`.

    `role` is the per-tenant membership role; `user_role` is the global
    `users.role`, which is a different axis entirely — `"admin"` there is the
    deployment operator bit, granted by nothing self-service.
    """
    async with session_factory() as session:
        user = User(name=name, email=email or f"{name}@example.invalid", role=user_role)
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role=role))
        await session.commit()
        return user.id


def _token(user_id: str, email: str, tenant_id: str | None) -> str:
    return create_jwt(
        user_id,
        email,
        "user",
        _KEYRING,
        tenant_id,
        session_version=0,
        auth_time=datetime.now(UTC),
    )


def _tenant_claim(response: httpx.Response) -> str | None:
    token = response.cookies.get("switch_auth")
    assert token is not None, "no session cookie was minted"
    claim: str | None = decode_jwt(token, _KEYRING).get("tenant_id")
    return claim


async def _make_unaffiliated_user(
    session_factory: async_sessionmaker[AsyncSession], *, name: str, role: str
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.invalid", role=role)
        session.add(user)
        await session.commit()
        return user.id


async def _last_tenant_id(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> str | None:
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        return UserStore().last_tenant_id(user)


async def _make_api_key(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    tenant_id: str,
    user_id: str,
    key_type: str = "registration",
) -> str:
    """A personal (non-agent) API key for `user_id` in `tenant_id`. Returns
    its `key_hash`."""
    key_hash = uuid.uuid4().hex
    async with session_factory() as session:
        session.add(
            ApiKey(
                tenant_id=tenant_id,
                user_id=user_id,
                key_hash=key_hash,
                encrypted_key="unused-in-tests",
                label="test-key",
                type=key_type,
            )
        )
        await session.commit()
    return key_hash


async def _make_agent_with_key(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    tenant_id: str,
    owner_id: str,
) -> tuple[str, str, str]:
    """An agent owned by `owner_id`, plus the `agents`-type key backing it.

    Returns `(agent_id, agent_name, key_hash)`. The agent's own client and
    api_key rows are constructed first — `agents.client_id` and
    `agents.api_key_id` are both foreign keys, not free-form strings.
    """
    key_hash = uuid.uuid4().hex
    name = f"agent-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        client = Client(
            tenant_id=tenant_id,
            transport_user_id=f"@bot-{uuid.uuid4().hex[:8]}:test",
            display_name="test-agent-bot",
            type="agent",
        )
        session.add(client)
        await session.flush()

        api_key = ApiKey(
            tenant_id=tenant_id,
            user_id=owner_id,
            key_hash=key_hash,
            encrypted_key="unused-in-tests",
            label="agent-key",
            type="agent",
        )
        session.add(api_key)
        await session.flush()

        agent = Agent(
            tenant_id=tenant_id,
            name=name,
            description="test agent",
            agent_type="other",
            connector_type="claude-code",
            integration_profile={},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=owner_id,
        )
        session.add(agent)
        await session.commit()
        return agent.id, name, key_hash


class TestCreateTenant:
    async def test_creating_a_tenant_makes_the_caller_its_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="founder", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "founder@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post("/tenants", json={"name": "Acme Corp"})

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["slug"] == "acme-corp"
        assert body["role"] == "admin"

        async with session_factory() as session:
            membership = await session.get(TenantMember, (body["id"], user_id))
            assert membership is not None
            assert membership.role == "admin"

    async def test_creating_a_tenant_switches_the_caller_into_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="mover", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "mover@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post("/tenants", json={"name": "Moving Co"})

        assert response.status_code == 201, response.text
        new_id = response.json()["id"]
        assert _tenant_claim(response) == new_id
        assert await _last_tenant_id(session_factory, user_id) == new_id

    async def test_a_caller_with_no_workspace_can_create_their_first(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_unaffiliated_user(
            session_factory, name="newcomer", role="user"
        )
        token = _token(user_id, "newcomer@example.invalid", None)

        async with _client(_app(session_factory, signup_mode="open"), token) as client:
            response = await client.post("/tenants", json={"name": "First Light"})

        assert response.status_code == 201, response.text
        assert response.json()["role"] == "admin"
        assert _tenant_claim(response) == response.json()["id"]

    async def test_a_taken_slug_gets_a_suffix_rather_than_a_409(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A 409 would tell the caller that a workspace of that name exists
        somewhere on the server. Nobody types the slug, so a suffixed one costs
        them nothing."""
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="second-founder", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "second-founder@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            first = await client.post("/tenants", json={"name": "Widgets Inc"})
            assert first.status_code == 201, first.text
            second = await client.post("/tenants", json={"name": "Widgets Inc"})

        assert second.status_code == 201, second.text
        assert first.json()["slug"] == "widgets-inc"
        assert second.json()["slug"].startswith("widgets-inc-")
        assert second.json()["id"] != first.json()["id"]

    async def test_invite_only_refuses_a_non_operator(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_unaffiliated_user(
            session_factory, name="hopeful", role="user"
        )
        token = _token(user_id, "hopeful@example.invalid", None)

        app = _app(session_factory, signup_mode="invite_only")
        async with _client(app, token) as client:
            response = await client.post("/tenants", json={"name": "Hopeful Ltd"})

        assert response.status_code == 403
        assert "invitation" in response.json()["detail"]
        async with session_factory() as session:
            assert (
                await session.execute(
                    select(Tenant).where(Tenant.name == "Hopeful Ltd")
                )
            ).first() is None

    async def test_invite_only_still_lets_an_operator_create(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _make_unaffiliated_user(
            session_factory, name="operator", role="admin"
        )
        token = create_jwt(
            user_id,
            "operator@example.invalid",
            "admin",
            _KEYRING,
            None,
            session_version=0,
            auth_time=datetime.now(UTC),
        )

        app = _app(session_factory, signup_mode="invite_only")
        async with _client(app, token) as client:
            response = await client.post("/tenants", json={"name": "Ops Co"})

        assert response.status_code == 201, response.text

    async def test_no_workspace_is_created_where_tenants_are_not_isolated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """With DB_REQUIRE_RESTRICTED_ROLE off the server keeps to one
        workspace, operators included: a second would run unisolated, and the
        next boot would refuse to start."""
        user_id = await _make_unaffiliated_user(
            session_factory, name="operator", role="admin"
        )
        token = create_jwt(
            user_id,
            "operator@example.invalid",
            "admin",
            _KEYRING,
            None,
            session_version=0,
            auth_time=datetime.now(UTC),
        )
        lifecycle = ClientLifecycleService(
            provisioning=MagicMock(),
            client_store=MagicMock(),
            tenant_store=TenantStore(),
            client_factory=MagicMock(),
            session_factory=session_factory,
            config=SimpleNamespace(id_server_name="test"),  # type: ignore[arg-type]
            tenants_isolated=False,
            ownership=NeverOwned(),  # type: ignore[arg-type]
            cursor_writer=MagicMock(),
        )

        app = _app(session_factory, client_lifecycle=lifecycle, signup_mode="open")
        async with _client(app, token) as client:
            response = await client.post("/tenants", json={"name": "Second Co"})

        assert response.status_code == 409, response.text
        assert "DB_REQUIRE_RESTRICTED_ROLE" in response.json()["detail"]
        async with session_factory() as session:
            assert (
                await session.execute(select(Tenant).where(Tenant.name == "Second Co"))
            ).first() is None

    async def test_a_failure_other_than_a_taken_slug_is_not_retried(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Retrying would leave the committed workspace behind, with no admin,
        and make another one."""
        user_id = await _make_unaffiliated_user(
            session_factory, name="unlucky", role="user"
        )
        token = _token(user_id, "unlucky@example.invalid", None)
        lifecycle = _ProvisioningFailsLifecycle(session_factory)

        app = _app(session_factory, client_lifecycle=lifecycle, signup_mode="open")
        async with _client(app, token) as client:
            with pytest.raises(IntegrityError):
                await client.post("/tenants", json={"name": "Unlucky Co"})

        assert lifecycle.calls == 1
        async with session_factory() as session:
            tenant = await session.scalar(
                select(Tenant).where(Tenant.name == "Unlucky Co")
            )
        assert tenant is not None and tenant.organization_id is not None

    async def test_any_failure_before_the_workspace_discards_its_organization(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Left behind, the organization would hold the slug in
        `organizations.slug` and push the next workspace of that name onto a
        suffix."""
        user_id = await _make_unaffiliated_user(
            session_factory, name="disconnected", role="user"
        )
        token = _token(user_id, "disconnected@example.invalid", None)
        lifecycle = _FailsBeforeTheWorkspaceLifecycle(session_factory)

        app = _app(session_factory, client_lifecycle=lifecycle, signup_mode="open")
        async with _client(app, token) as client:
            with pytest.raises(ConnectionResetError):
                await client.post("/tenants", json={"name": "Disconnected Co"})

        async with session_factory() as session:
            organization = await session.scalar(
                select(Organization).where(Organization.slug == "disconnected-co")
            )
        assert organization is None

    async def test_a_name_with_no_slug_characters_is_400(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="emoji-fan", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "emoji-fan@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post("/tenants", json={"name": "!!!"})

        assert response.status_code == 400


class TestWorkspaceCreationLimit:
    """`POST /tenants` is the one route here with no tenant to authorize
    against, so what stands in for its neighbours' role check is a bound on how
    many workspaces one person may own. It exists because a workspace is not
    just a row: `all_tenant_ids()` drives a fan-out per tenant at boot and a
    sweep every few seconds (`docs/old/multi-tenancy-phase2-tenants.md`, §5).
    """

    async def test_a_caller_at_the_limit_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="serial-founder", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "serial-founder@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=2)
        async with _client(app, token) as client:
            assert (
                await client.post("/tenants", json={"name": "First"})
            ).status_code == 201
            assert (
                await client.post("/tenants", json={"name": "Second"})
            ).status_code == 201
            third = await client.post("/tenants", json={"name": "Third"})

        assert third.status_code == 403
        assert "created 2 workspaces" in third.json()["detail"]

    async def test_nothing_is_provisioned_for_a_refused_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The bound is checked before `create_tenant`, so a refusal must not
        # leave the orphan workspace the handler's own docstring warns about.
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="blocked-founder", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "blocked-founder@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=0)
        async with _client(app, token) as client:
            response = await client.post("/tenants", json={"name": "Never Made"})

        assert response.status_code == 403
        async with session_factory() as session:
            found = await session.scalars(
                select(Tenant).where(Tenant.slug == "never-made")
            )
            assert found.first() is None

    async def test_handing_a_workspace_over_does_not_free_the_allowance(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # What is bounded is creation. Were it the workspaces someone administers,
        # creating, promoting a second account and stepping down would reset the
        # count every time.
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="hand-off", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "hand-off@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=1)
        async with _client(app, token) as client:
            first = await client.post("/tenants", json={"name": "Handed Over"})
            async with session_factory() as session:
                member = await session.get(TenantMember, (first.json()["id"], user_id))
                assert member is not None
                member.role = "member"
                await session.commit()
            second = await client.post("/tenants", json={"name": "One Too Many"})

        assert first.status_code == 201
        assert second.status_code == 403

    async def test_concurrent_requests_cannot_all_pass_the_check(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="burst", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "burst@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=1)
        async with _client(app, token) as client:
            responses = await asyncio.gather(
                *(
                    client.post("/tenants", json={"name": f"Burst {i}"})
                    for i in range(5)
                )
            )

        codes = sorted(r.status_code for r in responses)
        assert codes.count(201) == 1
        assert set(codes) - {201} <= {403, 409}
        async with session_factory() as session:
            owned = await session.scalars(
                select(TenantMember).where(
                    TenantMember.user_id == user_id, TenantMember.role == "admin"
                )
            )
            assert len(owned.all()) == 1

    async def test_a_request_during_another_creation_is_refused_not_queued(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Waiting would hold a pool connection for as long as the other
        # creation takes; refusing at once holds none.
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="in-flight", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "in-flight@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=3)
        async with session_factory() as holder:
            await holder.scalar(
                select(User).where(User.id == user_id).with_for_update(key_share=True)
            )
            async with _client(app, token) as client:
                response = await client.post("/tenants", json={"name": "Queued"})

        assert response.status_code == 409
        assert "being created" in response.json()["detail"]

    async def test_a_limit_of_zero_says_creation_is_disabled(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Zero is how a deployment closes the route, and it must not be
        # reported as though the caller had used up an allowance.
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="early-bird", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "early-bird@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=0)
        async with _client(app, token) as client:
            response = await client.post("/tenants", json={"name": "Too Early"})

        assert response.status_code == 403
        assert response.json()["detail"] == (
            "Workspace creation is disabled on this deployment"
        )

    async def test_memberships_the_caller_does_not_own_are_free(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Being invited into someone else's workspace must not spend an
        # allowance: the invitee cannot get it back without being removed.
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        user_id = await _make_member(
            session_factory, name="joiner", tenant_id=TENANT_A, role="admin"
        )
        async with session_factory() as session:
            session.add(
                TenantMember(tenant_id=TENANT_B, user_id=user_id, role="member")
            )
            await session.commit()
        token = _token(user_id, "joiner@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=1)
        async with _client(app, token) as client:
            response = await client.post("/tenants", json={"name": "Mine At Last"})

        assert response.status_code == 201, response.text

    async def test_an_operator_is_exempt(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # `users.role == "admin"` is the deployment operator bit, and this
        # bound is about self-service. An operator provisioning workspaces for
        # other people is exactly who it must not stop — the same bypass
        # `authz.administers_tenant` already gives them.
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory,
            name="the-operator",
            tenant_id=TENANT_A,
            role="member",
            user_role="admin",
        )
        token = _token(user_id, "the-operator@example.invalid", TENANT_A)

        app = _app(session_factory, max_workspaces_per_user=0)
        async with _client(app, token) as client:
            first = await client.post("/tenants", json={"name": "Customer One"})
            second = await client.post("/tenants", json={"name": "Customer Two"})

        assert first.status_code == 201, first.text
        assert second.status_code == 201, second.text

    async def test_the_operator_bit_is_read_fresh_not_from_the_token(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The JWT carries a role claim from login. Trusting it would keep a
        # revoked operator exempt for the life of their cookie, so the bit
        # comes from the `users` row on every request.
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="demoted", tenant_id=TENANT_A, role="member"
        )
        stale_operator_token = create_jwt(
            user_id,
            "demoted@example.invalid",
            "admin",
            _KEYRING,
            TENANT_A,
            session_version=0,
            auth_time=datetime.now(UTC),
        )

        async with _client(
            _app(session_factory, max_workspaces_per_user=0), stale_operator_token
        ) as client:
            response = await client.post("/tenants", json={"name": "Not Allowed"})

        assert response.status_code == 403


class TestInvitationAuthorisation:
    """A member of workspace A cannot mint an invitation to workspace B —
    each request is bound to exactly one tenant, and the path segment cannot
    override that."""

    async def test_a_plain_member_cannot_mint_an_invitation(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="rank-and-file", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "rank-and-file@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/invitations", json={"role": "member"}
            )

        assert response.status_code == 403

    async def test_an_admin_of_a_cannot_mint_an_invitation_naming_b(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        user_id = await _make_member(
            session_factory, name="a-admin", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "a-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_B}/invitations", json={"role": "member"}
            )

        assert response.status_code == 403

        async with tenant_session(session_factory, TENANT_B) as scoped:
            assert await InvitationStore().list_for_tenant(scoped) == []

    async def test_an_admin_can_mint_an_invitation_to_their_own_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="a-admin", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "a-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/invitations",
                json={"role": "member", "uses_remaining": 3},
            )

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["role"] == "member"
        assert body["uses_remaining"] == 3
        assert "token" in body and body["token"]

    async def test_an_absurd_expiry_is_refused_rather_than_crashing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`timedelta` raises `OverflowError` well before `int` runs out, so an
        expiry bounded only from below turns a bad request into a 500. The
        bound belongs on the schema, where it is a 422 with a field name."""
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="time-lord", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "time-lord@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/invitations",
                json={"role": "member", "expires_in_hours": 1000000000},
            )

        assert response.status_code == 422, response.text

    @pytest.mark.parametrize(("uses", "status"), [(100, 201), (101, 422)])
    async def test_a_link_cannot_be_made_effectively_unlimited(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        uses: int,
        status: int,
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="a-admin", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "a-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/invitations",
                json={"role": "member", "uses_remaining": uses},
            )

        assert response.status_code == status, response.text


class TestOneAdminRole:
    """`owner` merged into `admin`: every admin runs the workspace, other
    admins included, and a workspace always keeps at least one."""

    async def test_an_admin_can_demote_and_remove_another_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="admin-one", tenant_id=TENANT_A, role="admin"
        )
        other_id = await _make_member(
            session_factory, name="admin-two", tenant_id=TENANT_A, role="admin"
        )
        token = _token(admin_id, "admin-one@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            demote = await client.patch(
                f"/tenants/{TENANT_A}/members/{other_id}", json={"role": "member"}
            )
            remove = await client.delete(f"/tenants/{TENANT_A}/members/{other_id}")

        assert demote.status_code == 200, demote.text
        assert demote.json()["role"] == "member"
        assert remove.status_code == 200, remove.text

    async def test_a_client_asking_for_owner_gets_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A Console from before the merge still offers `owner`."""
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="old-console", tenant_id=TENANT_A, role="admin"
        )
        member_id = await _make_member(
            session_factory, name="promoted", tenant_id=TENANT_A, role="member"
        )
        token = _token(admin_id, "old-console@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            promote = await client.patch(
                f"/tenants/{TENANT_A}/members/{member_id}", json={"role": "owner"}
            )
            invite = await client.post(
                f"/tenants/{TENANT_A}/invitations", json={"role": "owner"}
            )

        assert promote.status_code == 200, promote.text
        assert promote.json()["role"] == "admin"
        assert invite.status_code == 201, invite.text
        assert invite.json()["role"] == "admin"

    async def test_an_unknown_role_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="typo", tenant_id=TENANT_A, role="admin"
        )
        token = _token(admin_id, "typo@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/invitations", json={"role": "superadmin"}
            )

        assert response.status_code == 400, response.text


class TestInvitationLifecycle:
    async def _mint(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        tenant_id: str,
        admin_id: str,
        role: str = "member",
        email: str | None = None,
        uses_remaining: int = 1,
        expires_in_hours: int = 168,
    ) -> tuple[str, str]:
        """Mint directly through the store (not the route) so a lifecycle
        test does not depend on `TestInvitationAuthorisation` passing first.
        Returns `(invitation_id, token)`."""
        async with tenant_session(session_factory, tenant_id) as session:
            invitation, token = await InvitationStore().create(
                session,
                role=role,
                email=email,
                expires_at=datetime.now(UTC) + timedelta(hours=expires_in_hours),
                uses_remaining=uses_remaining,
                created_by=admin_id,
            )
            await session.commit()
            return invitation.id, token

    async def test_accepting_grants_membership_in_the_invited_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="inviter", tenant_id=TENANT_A, role="admin"
        )
        _id, token = await self._mint(
            session_factory, tenant_id=TENANT_A, admin_id=admin_id, role="admin"
        )
        await _make_tenant(session_factory, TENANT_B)
        invitee_id = await _make_member(
            session_factory, name="invitee", tenant_id=TENANT_B, role="member"
        )
        caller_token = _token(invitee_id, "invitee@example.invalid", TENANT_B)

        async with _client(_app(session_factory), caller_token) as client:
            response = await client.post("/invitations/accept", json={"token": token})

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["id"] == TENANT_A
        assert body["role"] == "admin"
        assert _tenant_claim(response) == TENANT_A
        assert await _last_tenant_id(session_factory, invitee_id) == TENANT_A

        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, invitee_id))
            assert membership is not None
            assert membership.role == "admin"

    async def test_re_accepting_an_invitation_you_already_hold_costs_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A shared link is double-clicked, or reloaded, or opened on a phone
        as well. The second acceptance grants nothing new, so it must spend
        nothing either — otherwise one careless refresh burns a seat that was
        meant for somebody else, and the invitation dies with nobody's
        membership to show for it.
        """
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="link-sharer", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, token = await self._mint(
            session_factory, tenant_id=TENANT_A, admin_id=admin_id, uses_remaining=2
        )
        await _make_tenant(session_factory, TENANT_B)
        invitee_id = await _make_member(
            session_factory, name="double-clicker", tenant_id=TENANT_B, role="member"
        )

        app = _app(session_factory)
        async with _client(
            app, _token(invitee_id, "double-clicker@example.invalid", TENANT_B)
        ) as client:
            first = await client.post("/invitations/accept", json={"token": token})
            second = await client.post("/invitations/accept", json={"token": token})

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert second.json()["role"] == first.json()["role"]

        async with tenant_session(session_factory, TENANT_A) as session:
            invitation = await session.get(Invitation, invitation_id)
            assert invitation is not None
            assert invitation.uses_remaining == 1

    async def test_accepting_twice_fails_the_second_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="inviter2", tenant_id=TENANT_A, role="admin"
        )
        _id, token = await self._mint(
            session_factory, tenant_id=TENANT_A, admin_id=admin_id, uses_remaining=1
        )
        await _make_tenant(session_factory, TENANT_B)
        first_invitee = await _make_member(
            session_factory, name="first-invitee", tenant_id=TENANT_B, role="member"
        )
        second_invitee = await _make_member(
            session_factory, name="second-invitee", tenant_id=TENANT_B, role="member"
        )

        app = _app(session_factory)
        async with _client(
            app, _token(first_invitee, "first-invitee@example.invalid", TENANT_B)
        ) as client:
            first = await client.post("/invitations/accept", json={"token": token})
        assert first.status_code == 200, first.text

        async with _client(
            app, _token(second_invitee, "second-invitee@example.invalid", TENANT_B)
        ) as client:
            second = await client.post("/invitations/accept", json={"token": token})

        assert second.status_code == 403
        assert "used" in second.json()["detail"].lower()

        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, second_invitee)) is None

    async def test_a_revoked_invitation_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="revoker", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, token = await self._mint(
            session_factory, tenant_id=TENANT_A, admin_id=admin_id
        )
        async with tenant_session(session_factory, TENANT_A) as session:
            await InvitationStore().revoke(session, invitation_id)
            await session.commit()

        await _make_tenant(session_factory, TENANT_B)
        invitee_id = await _make_member(
            session_factory, name="too-late", tenant_id=TENANT_B, role="member"
        )

        async with _client(
            _app(session_factory),
            _token(invitee_id, "too-late@example.invalid", TENANT_B),
        ) as client:
            response = await client.post("/invitations/accept", json={"token": token})

        assert response.status_code == 403
        assert "revoked" in response.json()["detail"].lower()

    async def test_an_expired_invitation_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="expiry-setter", tenant_id=TENANT_A, role="admin"
        )
        _id, token = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=admin_id,
            expires_in_hours=1,
        )
        # Force it into the past directly — the store only accepts a future
        # `expires_at` implicitly by convention, not by constraint, so this is
        # the straightforward way to get an already-expired row.
        async with session_factory() as session:
            result = await session.execute(select(Invitation))
            invitation = result.scalars().one()
            invitation.expires_at = datetime.now(UTC) - timedelta(hours=1)  # type: ignore[assignment]
            await session.commit()

        await _make_tenant(session_factory, TENANT_B)
        invitee_id = await _make_member(
            session_factory, name="too-slow", tenant_id=TENANT_B, role="member"
        )

        async with _client(
            _app(session_factory),
            _token(invitee_id, "too-slow@example.invalid", TENANT_B),
        ) as client:
            response = await client.post("/invitations/accept", json={"token": token})

        assert response.status_code == 403
        assert "expired" in response.json()["detail"].lower()

    async def test_an_email_bound_invitation_refuses_a_different_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="picky-inviter", tenant_id=TENANT_A, role="admin"
        )
        _id, token = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=admin_id,
            email="expected@example.invalid",
        )
        await _make_tenant(session_factory, TENANT_B)
        wrong_person = await _make_member(
            session_factory,
            name="wrong-person",
            tenant_id=TENANT_B,
            role="member",
            email="someone-else@example.invalid",
        )

        async with _client(
            _app(session_factory),
            _token(wrong_person, "someone-else@example.invalid", TENANT_B),
        ) as client:
            response = await client.post("/invitations/accept", json={"token": token})

        assert response.status_code == 403
        assert "email" in response.json()["detail"].lower()

    async def test_an_email_bound_invitation_accepts_the_addressed_email(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="picky-inviter2", tenant_id=TENANT_A, role="admin"
        )
        _id, token = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=admin_id,
            email="right-person@example.invalid",
        )
        await _make_tenant(session_factory, TENANT_B)
        right_person = await _make_member(
            session_factory,
            name="right-person",
            tenant_id=TENANT_B,
            role="member",
            email="right-person@example.invalid",
        )

        async with _client(
            _app(session_factory),
            _token(right_person, "right-person@example.invalid", TENANT_B),
        ) as client:
            response = await client.post("/invitations/accept", json={"token": token})

        assert response.status_code == 200, response.text


TENANT_C = "tenant-api-routes-c"


class TestInvitationsAddressedToMe:
    _mint = TestInvitationLifecycle._mint

    async def _invitee(
        self, session_factory: async_sessionmaker[AsyncSession], name: str
    ) -> tuple[str, str]:
        """A signed-in person with a workspace of their own, and their cookie."""
        await _make_tenant(session_factory, TENANT_B)
        email = f"{name}@example.invalid"
        user_id = await _make_member(
            session_factory, name=name, tenant_id=TENANT_B, role="member", email=email
        )
        return user_id, _token(user_id, email, TENANT_B)

    async def test_lists_live_invitations_to_my_address_in_workspaces_i_am_not_in(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        invitee_id, cookie = await self._invitee(session_factory, "sought-after")
        for tenant_id in (TENANT_A, TENANT_C):
            await _make_tenant(session_factory, tenant_id)
        inviter_a = await _make_member(
            session_factory, name="Ada", tenant_id=TENANT_A, role="admin"
        )
        inviter_c = await _make_member(
            session_factory, name="Cy", tenant_id=TENANT_C, role="admin"
        )
        wanted_a, _ = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=inviter_a,
            role="admin",
            email="Sought-After@example.invalid",
        )
        wanted_c, _ = await self._mint(
            session_factory,
            tenant_id=TENANT_C,
            admin_id=inviter_c,
            email="sought-after@example.invalid",
        )
        await self._mint(session_factory, tenant_id=TENANT_A, admin_id=inviter_a)
        await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=inviter_a,
            email="someone-else@example.invalid",
        )
        inviter_b = await _make_member(
            session_factory, name="Bo", tenant_id=TENANT_B, role="admin"
        )
        await self._mint(
            session_factory,
            tenant_id=TENANT_B,
            admin_id=inviter_b,
            email="sought-after@example.invalid",
        )

        async with _client(_app(session_factory), cookie) as client:
            response = await client.get("/invitations/mine")

        assert response.status_code == 200, response.text
        found = {i["id"]: i for i in response.json()}
        assert set(found) == {wanted_a, wanted_c}
        assert found[wanted_a]["tenant_id"] == TENANT_A
        assert found[wanted_a]["tenant_name"] == TENANT_A
        assert found[wanted_a]["role"] == "admin"
        assert found[wanted_a]["invited_by"] == "Ada"
        assert "token" not in found[wanted_a]

    async def test_accepting_by_id_joins_switches_and_spends_a_use(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        invitee_id, cookie = await self._invitee(session_factory, "joiner")
        await _make_tenant(session_factory, TENANT_A)
        inviter = await _make_member(
            session_factory, name="inviter", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, _ = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=inviter,
            email="joiner@example.invalid",
        )

        async with _client(_app(session_factory), cookie) as client:
            response = await client.post(
                "/invitations/mine/accept",
                json={"tenant_id": TENANT_A, "invitation_id": invitation_id},
            )
            after = await client.get("/invitations/mine")

        assert response.status_code == 200, response.text
        assert response.json()["id"] == TENANT_A
        assert response.json()["role"] == "member"
        assert _tenant_claim(response) == TENANT_A
        assert await _last_tenant_id(session_factory, invitee_id) == TENANT_A
        assert after.json() == []
        async with tenant_session(session_factory, TENANT_A) as session:
            invitation = await session.get(Invitation, invitation_id)
            assert invitation is not None
            assert invitation.uses_remaining == 0
            assert await session.get(TenantMember, (TENANT_A, invitee_id)) is not None

    async def test_a_shareable_link_is_not_accepted_by_its_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Without an address the token is the only credential; its id is
        not one."""
        _invitee_id, cookie = await self._invitee(session_factory, "id-guesser")
        await _make_tenant(session_factory, TENANT_A)
        inviter = await _make_member(
            session_factory, name="inviter", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, _ = await self._mint(
            session_factory, tenant_id=TENANT_A, admin_id=inviter
        )

        async with _client(_app(session_factory), cookie) as client:
            response = await client.post(
                "/invitations/mine/accept",
                json={"tenant_id": TENANT_A, "invitation_id": invitation_id},
            )

        assert response.status_code == 404
        async with tenant_session(session_factory, TENANT_A) as session:
            invitation = await session.get(Invitation, invitation_id)
            assert invitation is not None
            assert invitation.uses_remaining == 1

    async def test_someone_elses_invitation_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _invitee_id, cookie = await self._invitee(session_factory, "not-them")
        await _make_tenant(session_factory, TENANT_A)
        inviter = await _make_member(
            session_factory, name="inviter", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, _ = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=inviter,
            email="them@example.invalid",
        )

        async with _client(_app(session_factory), cookie) as client:
            response = await client.post(
                "/invitations/mine/accept",
                json={"tenant_id": TENANT_A, "invitation_id": invitation_id},
            )

        assert response.status_code == 404

    async def test_an_invitation_named_under_the_wrong_workspace_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _invitee_id, cookie = await self._invitee(session_factory, "misdirected")
        for tenant_id in (TENANT_A, TENANT_C):
            await _make_tenant(session_factory, tenant_id)
        inviter = await _make_member(
            session_factory, name="inviter", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, _ = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=inviter,
            email="misdirected@example.invalid",
        )

        async with _client(_app(session_factory), cookie) as client:
            response = await client.post(
                "/invitations/mine/accept",
                json={"tenant_id": TENANT_C, "invitation_id": invitation_id},
            )

        assert response.status_code == 404
        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_C, _invitee_id)) is None

    async def test_a_revoked_invitation_says_so(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _invitee_id, cookie = await self._invitee(session_factory, "too-late")
        await _make_tenant(session_factory, TENANT_A)
        inviter = await _make_member(
            session_factory, name="inviter", tenant_id=TENANT_A, role="admin"
        )
        invitation_id, _ = await self._mint(
            session_factory,
            tenant_id=TENANT_A,
            admin_id=inviter,
            email="too-late@example.invalid",
        )
        async with tenant_session(session_factory, TENANT_A) as session:
            await InvitationStore().revoke(session, invitation_id)
            await session.commit()

        async with _client(_app(session_factory), cookie) as client:
            response = await client.post(
                "/invitations/mine/accept",
                json={"tenant_id": TENANT_A, "invitation_id": invitation_id},
            )

        assert response.status_code == 403
        assert "revoked" in response.json()["detail"]


class TestMemberRoutes:
    async def test_listing_shows_every_member_and_their_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="list-admin", tenant_id=TENANT_A, role="admin"
        )
        await _make_member(
            session_factory, name="list-member", tenant_id=TENANT_A, role="member"
        )
        token = _token(admin_id, "list-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/members")

        assert response.status_code == 200, response.text
        roles = {row["name"]: row["role"] for row in response.json()}
        assert roles == {"list-admin": "admin", "list-member": "member"}

    async def test_listing_flags_the_bootstrap_owner_as_a_service_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="Agent Bootstrap", tenant_id=TENANT_A, role="admin"
        )
        bootstrap_id = await _make_member(
            session_factory, name="robot", tenant_id=TENANT_A, role="member"
        )
        async with session_factory() as session:
            bootstrap = await session.get(User, bootstrap_id)
            assert bootstrap is not None
            bootstrap.metadata_ = {BOOTSTRAP_OWNER_MARKER_META_KEY: True}
            await session.commit()
        token = _token(admin_id, "Agent Bootstrap@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/members")

        assert response.status_code == 200, response.text
        flags = {row["name"]: row["service_account"] for row in response.json()}
        assert flags == {"Agent Bootstrap": False, "robot": True}

    @pytest.mark.parametrize("another_admin", [True, False])
    async def test_an_admin_steps_down_while_another_admin_remains(
        self, session_factory: async_sessionmaker[AsyncSession], another_admin: bool
    ) -> None:
        """Their own row is theirs to change; the last admin of all stays."""
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="stepping-down", tenant_id=TENANT_A, role="admin"
        )
        await _make_member(
            session_factory,
            name="other",
            tenant_id=TENANT_A,
            role="admin" if another_admin else "member",
        )
        token = _token(admin_id, "stepping-down@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{admin_id}", json={"role": "member"}
            )

        assert response.status_code == (200 if another_admin else 409), response.text
        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, admin_id))
            assert membership is not None
            assert membership.role == ("member" if another_admin else "admin")

    async def test_an_admin_can_be_demoted_when_another_admin_remains(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="admin-one", tenant_id=TENANT_A, role="admin"
        )
        other_admin_id = await _make_member(
            session_factory, name="admin-two", tenant_id=TENANT_A, role="admin"
        )
        token = _token(admin_id, "admin-one@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{other_admin_id}",
                json={"role": "member"},
            )

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "member"

    @pytest.mark.parametrize("another_admin", [True, False])
    async def test_an_admin_leaves_while_another_admin_remains(
        self, session_factory: async_sessionmaker[AsyncSession], another_admin: bool
    ) -> None:
        """As with their own role. Having left, the session no longer names
        the workspace: it is re-minted onto none, their only one gone."""
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="leaving", tenant_id=TENANT_A, role="admin"
        )
        await _make_member(
            session_factory,
            name="other",
            tenant_id=TENANT_A,
            role="admin" if another_admin else "member",
        )
        token = _token(admin_id, "leaving@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{admin_id}")

        assert response.status_code == (200 if another_admin else 409), response.text
        async with session_factory() as session:
            left = await session.get(TenantMember, (TENANT_A, admin_id)) is None
        assert left is another_admin
        assert ("set-cookie" in response.headers) is another_admin

    async def test_removing_a_member_deletes_their_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="remover", tenant_id=TENANT_A, role="admin"
        )
        target_id = await _make_member(
            session_factory, name="removed", tenant_id=TENANT_A, role="member"
        )
        token = _token(admin_id, "remover@example.invalid", TENANT_A)
        async with tenant_session(session_factory, TENANT_A) as session:
            await ServiceConnectionStore().save_connection(
                session,
                user_id=target_id,
                service="github",
                consent="write",
                granted_scopes=[],
                account_id="1001",
                external_identity="removed-user",
                encrypted_secret=_KEYRING.encrypt(
                    json.dumps({"access_token": "SYNTHETIC-USER-TOKEN"})
                ),
                oauth_client_id=None,
            )
            session.add(
                ServiceTokenIssuance(
                    grant_id="grant",
                    agent_id="agent",
                    owner_id=target_id,
                    service="github",
                    principal="agent_key",
                    controller_id=None,
                    permissions={},
                    resources={},
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                    token_sha256="0" * 64,
                    encrypted_token=_KEYRING.encrypt("SYNTHETIC-REPOSITORY"),
                    revoke_requested=False,
                    attempts=0,
                )
            )
            await session.commit()

        app = _app(session_factory)
        for state, user_id, kind in (
            ("removed-github", target_id, "github"),
            ("removed-service", target_id, "service"),
            ("other", admin_id, "github"),
        ):
            await app.state.sign_in_flows.start(
                kind=kind,
                service="github" if kind == "github" else "example",
                tenant_id=TENANT_A,
                user_id=user_id,
                state=state,
                mode="core",
                port=43123,
                redirect_uri="https://switch.example.com/callback",
                owner_label="someone",
                details={},
                completion_secret="c" * 43,
            )
        github = SimpleNamespace(revoke=AsyncMock())
        app.state.github_connections = github
        app.state.service_broker = ServiceBroker(
            session_factory=session_factory,
            keyring=_KEYRING,
            catalog=CATALOG,
            adapters={"github": GitHubAdapter(github, AsyncMock())},  # type: ignore[arg-type]
            organization_apps=None,
            disabled={},
            store=ServiceConnectionStore(),
            token_retention=timedelta(days=30),
            workspace_services=WorkspaceServiceStore(),
            workspace_gate=False,
            public_url=None,
        )
        async with _client(app, token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")

        assert response.status_code == 200, response.text
        github.revoke.assert_awaited_once_with("SYNTHETIC-USER-TOKEN")
        async with session_factory() as session:
            assert set((await session.execute(select(SignInFlow.id))).scalars()) == {
                "other"
            }
        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, target_id)) is None
            issued = await session.scalar(
                select(ServiceTokenIssuance).where(
                    ServiceTokenIssuance.owner_id == target_id
                )
            )
            assert issued is not None and issued.encrypted_token is None

    async def test_removing_a_member_stops_their_api_key_working(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The bite test: after removal, the credential the member minted in
        this tenant no longer resolves to anything — not merely hidden, gone.
        A live bearer-auth attempt with the same hash would fail at the very
        first lookup `ApiKeyStore.get_by_hash` performs.
        """
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="key-remover", tenant_id=TENANT_A, role="admin"
        )
        target_id = await _make_member(
            session_factory, name="key-holder", tenant_id=TENANT_A, role="member"
        )
        key_hash = await _make_api_key(
            session_factory, tenant_id=TENANT_A, user_id=target_id
        )
        token = _token(admin_id, "key-remover@example.invalid", TENANT_A)

        async with session_factory() as session:
            assert await ApiKeyStore().get_by_hash(session, key_hash) is not None

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")
        assert response.status_code == 200, response.text

        async with session_factory() as session:
            assert await ApiKeyStore().get_by_hash(session, key_hash) is None

    async def test_a_member_who_owns_an_agent_here_cannot_be_removed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An agent is not the member's private property to lose along with
        their membership — it sits in rooms with other people, and deleting it
        is not recoverable the way reminting a key is. Removal must refuse,
        naming the agent, and this must not be a partial write: not the
        membership, not the member's unrelated personal key, not the agent's
        own key may be touched when the route 409s.
        """
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="agent-remover", tenant_id=TENANT_A, role="admin"
        )
        target_id = await _make_member(
            session_factory, name="agent-owner", tenant_id=TENANT_A, role="member"
        )
        agent_id, agent_name, agent_key_hash = await _make_agent_with_key(
            session_factory, tenant_id=TENANT_A, owner_id=target_id
        )
        personal_key_hash = await _make_api_key(
            session_factory, tenant_id=TENANT_A, user_id=target_id
        )
        token = _token(admin_id, "agent-remover@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")

        assert response.status_code == 409, response.text
        assert agent_name in response.json()["detail"]

        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, target_id)) is not None
            assert await AgentStore().get(session, agent_id) is not None
            assert await ApiKeyStore().get_by_hash(session, agent_key_hash) is not None
            assert (
                await ApiKeyStore().get_by_hash(session, personal_key_hash) is not None
            )

    async def test_a_plain_member_cannot_remove_anyone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        member_id = await _make_member(
            session_factory, name="powerless", tenant_id=TENANT_A, role="member"
        )
        target_id = await _make_member(
            session_factory, name="untouchable", tenant_id=TENANT_A, role="member"
        )
        token = _token(member_id, "powerless@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")

        assert response.status_code == 403


def _window() -> dict[str, str]:
    now = datetime.now(UTC)
    return {
        "since": (now - timedelta(hours=1)).isoformat(),
        "until": (now + timedelta(hours=1)).isoformat(),
    }


class TestCurrentTenantRoute:
    async def test_a_members_request_reads_the_organization_once_at_most(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        statement_counts: StatementCounts,
    ) -> None:
        """Checking a member's role reads their membership row, and the
        organization only when that row does not answer, so a workspace in an
        organization costs a member no more statements than one without."""
        tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
        organization_id = f"org-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            session.add(
                Organization(id=organization_id, slug=organization_id, name="O")
            )
            await session.flush()
            session.add(
                Tenant(
                    id=tenant_id,
                    slug=tenant_id,
                    name=tenant_id,
                    organization_id=organization_id,
                )
            )
            await session.commit()
        user_id = await _make_member(
            session_factory,
            name=f"counted-{uuid.uuid4().hex[:6]}",
            tenant_id=tenant_id,
            role="member",
        )
        async with session_factory() as session:
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=user_id, role="member"
                )
            )
            await session.commit()
        token = _token(user_id, "counted@example.invalid", tenant_id)

        async with _client(
            statement_counts.wrap(_app(session_factory)), token
        ) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 200, response.text
        statements = statement_counts.scopes[-1].statements
        assert sum("organization_members" in s for s in statements) == 1
        assert len(statements) <= 7, statements

    async def test_a_member_is_told_the_workspace_they_are_bound_to(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        user_id = await _make_member(
            session_factory, name="current-member", tenant_id=TENANT_A, role="member"
        )
        async with session_factory() as session:
            session.add(TenantMember(tenant_id=TENANT_B, user_id=user_id, role="admin"))
            await session.commit()
        token = _token(user_id, "current-member@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 200
        assert response.json() == {
            "id": TENANT_A,
            "slug": TENANT_A,
            "name": TENANT_A,
            "role": "member",
            "organization_role": None,
            "organization_id": None,
            "archived_at": None,
            "administers": False,
            "can_delete": False,
            "can_manage_data_protection": False,
        }

    @pytest.mark.parametrize(
        ("role", "user_role"),
        [("admin", "user"), ("member", "admin")],
    )
    async def test_an_admin_or_operator_is_told_they_administer_it(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        role: str,
        user_role: str,
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory,
            name="current-admin",
            tenant_id=TENANT_A,
            role=role,
            user_role=user_role,
        )
        token = _token(user_id, "current-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 200
        assert response.json()["administers"] is True


class TestOrganizationAdmins:
    """An organization's `org_admin` administers every workspace in it, and
    may bind one without holding a membership row there."""

    async def _organization_of(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *tenant_ids: str,
        members: dict[str, str],
    ) -> str:
        """An organization owning `tenant_ids`, with `members` (user id ->
        organization role)."""
        organization_id = f"org-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            session.add(
                Organization(id=organization_id, slug=organization_id, name="Acme")
            )
            await session.flush()
            for tenant_id in tenant_ids:
                session.add(
                    Tenant(
                        id=tenant_id,
                        slug=tenant_id,
                        name=tenant_id,
                        organization_id=organization_id,
                    )
                )
            for user_id, role in members.items():
                session.add(
                    OrganizationMember(
                        organization_id=organization_id, user_id=user_id, role=role
                    )
                )
            await session.commit()
        return organization_id

    async def test_an_org_admin_binds_a_workspace_they_are_not_a_member_of(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        organization_id = await self._organization_of(
            session_factory, TENANT_A, members={admin_id: "org_admin"}
        )
        token = _token(admin_id, "org-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 200, response.text
        assert response.json() == {
            "id": TENANT_A,
            "slug": TENANT_A,
            "name": TENANT_A,
            "role": "admin",
            "organization_role": "org_admin",
            "organization_id": organization_id,
            "archived_at": None,
            "administers": True,
            # An organization admin administers it, but deletes it, erases
            # people and sets messages to be deleted only by an admin
            # membership of their own.
            "can_delete": False,
            "can_manage_data_protection": False,
        }

    async def test_an_org_admin_is_offered_and_may_switch_to_every_workspace_of_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, TENANT_B, members={admin_id: "org_admin"}
        )
        token = _token(admin_id, "org-admin@example.invalid", None)

        async with _client(_app(session_factory), token) as client:
            listed = await client.get("/tenants")
            switched = await client.post(f"/tenants/{TENANT_B}/switch")

        assert listed.status_code == 200, listed.text
        assert {
            (t["id"], t["role"], t["organization_role"]) for t in listed.json()
        } == {
            (TENANT_A, "admin", "org_admin"),
            (TENANT_B, "admin", "org_admin"),
        }
        assert switched.status_code == 200, switched.text
        assert _tenant_claim(switched) == TENANT_B

    @pytest.mark.parametrize(
        ("signed_in_days_ago", "status"), [(3, 200), (SESSION_MAX_AGE.days + 1, 401)]
    )
    async def test_switching_keeps_when_the_session_signed_in(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        signed_in_days_ago: int,
        status: int,
    ) -> None:
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, TENANT_B, members={admin_id: "org_admin"}
        )
        signed_in = datetime.now(UTC) - timedelta(days=signed_in_days_ago)
        token = create_jwt(
            admin_id,
            "org-admin@example.invalid",
            "user",
            _KEYRING,
            None,
            session_version=0,
            auth_time=datetime.now(UTC),
        )
        claims = decode_jwt(token, _KEYRING)
        claims["auth_time"] = int(signed_in.timestamp())
        forged = jwt.encode(
            claims,
            _KEYRING.derive(Purpose.SESSION),
            algorithm=JWT_ALGORITHM,
            headers={"kid": _KEYRING.current.id},
        )

        async with _client(_app(session_factory), forged) as client:
            switched = await client.post(f"/tenants/{TENANT_B}/switch")

        assert switched.status_code == status, switched.text
        if status == 200:
            minted = decode_jwt(switched.cookies["switch_auth"], _KEYRING)
            assert minted["auth_time"] == int(signed_in.timestamp())

    async def test_an_org_admin_may_not_bind_another_organizations_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, members={admin_id: "org_admin"}
        )
        await self._organization_of(session_factory, TENANT_B, members={})
        token = _token(admin_id, "org-admin@example.invalid", TENANT_B)

        async with _client(_app(session_factory), token) as client:
            current = await client.get("/tenants/current")
            switched = await client.post(f"/tenants/{TENANT_B}/switch")

        assert current.status_code == 403
        assert switched.status_code == 403

    async def test_an_organization_member_binds_only_their_own_workspaces(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        member_id = await _make_unaffiliated_user(
            session_factory, name="org-member", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, members={member_id: "member"}
        )
        token = _token(member_id, "org-member@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 403

    async def test_an_org_admin_manages_members_as_a_workspace_admin_does(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Including other admins, as any admin may; and like them, not the
        workspace's last admin of its own, whom the organization's admin does
        not stand in for."""
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, members={admin_id: "org_admin"}
        )
        first_id = await _make_member(
            session_factory, name="ws-admin-1", tenant_id=TENANT_A, role="admin"
        )
        last_id = await _make_member(
            session_factory, name="ws-admin-2", tenant_id=TENANT_A, role="admin"
        )
        token = _token(admin_id, "org-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            demoted = await client.patch(
                f"/tenants/{TENANT_A}/members/{first_id}", json={"role": "member"}
            )
            last = await client.patch(
                f"/tenants/{TENANT_A}/members/{last_id}", json={"role": "member"}
            )

        assert demoted.status_code == 200, demoted.text
        assert demoted.json()["role"] == "member"
        assert last.status_code == 409, last.text
        assert last.json()["detail"] == "Cannot demote the last admin"

    async def test_an_org_admin_cannot_remove_the_workspaces_last_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, members={admin_id: "org_admin"}
        )
        last_id = await _make_member(
            session_factory, name="ws-admin", tenant_id=TENANT_A, role="admin"
        )
        token = _token(admin_id, "org-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{last_id}")

        assert response.status_code == 409, response.text
        assert response.json()["detail"] == "Cannot remove the last admin"
        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, last_id)) is not None

    @pytest.mark.parametrize("method", ["patch", "delete"])
    async def test_a_workspace_cannot_demote_or_remove_an_org_admin(
        self, session_factory: async_sessionmaker[AsyncSession], method: str
    ) -> None:
        """Their standing comes from the organization; changing the row here
        would take nothing away while looking as if it had."""
        organization_id = await self._organization_of(
            session_factory, TENANT_A, members={}
        )
        workspace_admin_id = await _make_member(
            session_factory, name="ws-admin", tenant_id=TENANT_A, role="admin"
        )
        admin_id = await _make_member(
            session_factory, name="org-admin", tenant_id=TENANT_A, role="admin"
        )
        async with session_factory() as session:
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=admin_id, role="org_admin"
                )
            )
            await session.commit()
        token = _token(workspace_admin_id, "ws-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            if method == "patch":
                response = await client.patch(
                    f"/tenants/{TENANT_A}/members/{admin_id}", json={"role": "member"}
                )
            else:
                response = await client.delete(
                    f"/tenants/{TENANT_A}/members/{admin_id}"
                )

        assert response.status_code == 409, response.text
        assert "organization" in response.json()["detail"]
        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, admin_id))
        assert membership is not None and membership.role == "admin"

    @pytest.mark.parametrize("caller", ["ws-admin", "member", "org-admin"])
    async def test_each_member_row_says_what_the_caller_may_do_with_it(
        self, session_factory: async_sessionmaker[AsyncSession], caller: str
    ) -> None:
        """An admin may change and remove anyone, themselves included, but an
        organization admin, whose standing comes from the organization; a
        transfer may go to anyone with a membership here but the caller."""
        org_admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        org_admin_member_id = await _make_unaffiliated_user(
            session_factory, name="org-admin-member", role="user"
        )
        await self._organization_of(
            session_factory,
            TENANT_A,
            members={org_admin_id: "org_admin", org_admin_member_id: "org_admin"},
        )
        async with session_factory() as session:
            session.add(
                TenantMember(
                    tenant_id=TENANT_A, user_id=org_admin_member_id, role="member"
                )
            )
            await session.commit()
        ids = {
            "ws-admin": await _make_member(
                session_factory, name="ws-admin", tenant_id=TENANT_A, role="admin"
            ),
            "member": await _make_member(
                session_factory, name="member", tenant_id=TENANT_A, role="member"
            ),
            "org-admin": org_admin_id,
            "org-admin-member": org_admin_member_id,
        }
        token = _token(ids[caller], f"{caller}@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/members")

        assert response.status_code == 200, response.text
        rows = {
            row["name"]: (
                row["can_change_role"],
                row["can_remove"],
                row["can_receive_transfer"],
            )
            for row in response.json()
        }
        administers = caller != "member"
        expected = {
            "ws-admin": (administers, administers, True),
            "member": (administers, administers, True),
            # Listed through the organization, with no membership here.
            "org-admin": (False, False, False),
            "org-admin-member": (False, False, True),
        }
        # An admin's own row is theirs to change too; nobody hands themselves
        # anything.
        change, remove, _ = expected[caller]
        expected[caller] = (change, remove, False)
        assert rows == expected


class TestWorkspaceDeletionFlag:
    async def test_an_admin_member_is_told_they_may_delete_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="ws-admin", tenant_id=TENANT_A, role="admin"
        )
        token = _token(admin_id, "ws-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 200, response.text
        assert response.json()["can_delete"] is True

    async def test_nobody_is_told_they_may_delete_the_default_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id = await _make_member(
            session_factory, name="zero-admin", tenant_id=TENANT_ZERO_ID, role="admin"
        )
        token = _token(admin_id, "zero-admin@example.invalid", TENANT_ZERO_ID)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/current")

        assert response.status_code == 200, response.text
        assert response.json()["administers"] is True
        assert response.json()["can_delete"] is False


class TestWorkspaceCountsRoute:
    """`GET /tenants/counts`: people and agents for each workspace the caller
    may enter, for the dashboard's workspace switcher."""

    async def _organization_of(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *tenant_ids: str,
        members: dict[str, str],
    ) -> None:
        organization_id = f"org-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            session.add(
                Organization(id=organization_id, slug=organization_id, name="Acme")
            )
            await session.flush()
            for tenant_id in tenant_ids:
                session.add(
                    Tenant(
                        id=tenant_id,
                        slug=tenant_id,
                        name=tenant_id,
                        organization_id=organization_id,
                    )
                )
            for user_id, role in members.items():
                session.add(
                    OrganizationMember(
                        organization_id=organization_id, user_id=user_id, role=role
                    )
                )
            await session.commit()

    async def test_counts_each_workspace_of_a_member_on_its_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        member_id = await _make_member(
            session_factory, name="both", tenant_id=TENANT_A, role="member"
        )
        async with session_factory() as session:
            session.add(
                TenantMember(tenant_id=TENANT_B, user_id=member_id, role="admin")
            )
            await session.commit()
        other_id = await _make_member(
            session_factory, name="a-only", tenant_id=TENANT_A, role="admin"
        )
        for _ in range(2):
            await _make_agent_with_key(
                session_factory, tenant_id=TENANT_A, owner_id=other_id
            )
        await _make_agent_with_key(
            session_factory, tenant_id=TENANT_B, owner_id=member_id
        )
        token = _token(member_id, "both@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/counts")

        assert response.status_code == 200, response.text
        assert sorted(response.json(), key=lambda row: row["id"]) == [
            {"id": TENANT_A, "users": 2, "agents": 2},
            {"id": TENANT_B, "users": 1, "agents": 1},
        ]

    async def test_counts_an_org_admin_once_whether_or_not_they_are_a_member(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id = await _make_unaffiliated_user(
            session_factory, name="org-admin", role="user"
        )
        await self._organization_of(
            session_factory, TENANT_A, TENANT_B, members={admin_id: "org_admin"}
        )
        async with session_factory() as session:
            session.add(
                TenantMember(tenant_id=TENANT_A, user_id=admin_id, role="admin")
            )
            await session.commit()
        await _make_member(
            session_factory, name="b-member", tenant_id=TENANT_B, role="member"
        )
        token = _token(admin_id, "org-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/counts")

        assert response.status_code == 200, response.text
        assert sorted(response.json(), key=lambda row: row["id"]) == [
            {"id": TENANT_A, "users": 1, "agents": 0},
            {"id": TENANT_B, "users": 2, "agents": 0},
        ]

    async def test_an_org_member_who_is_no_admin_counts_only_where_they_are_a_member(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        member_id = await _make_unaffiliated_user(
            session_factory, name="org-member", role="user"
        )
        bystander_id = await _make_unaffiliated_user(
            session_factory, name="bystander", role="user"
        )
        await self._organization_of(
            session_factory,
            TENANT_A,
            members={member_id: "member", bystander_id: "member"},
        )
        async with session_factory() as session:
            session.add(
                TenantMember(tenant_id=TENANT_A, user_id=member_id, role="member")
            )
            await session.commit()
        token = _token(member_id, "org-member@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/counts")

        assert response.status_code == 200, response.text
        assert response.json() == [{"id": TENANT_A, "users": 1, "agents": 0}]

    async def test_the_operator_is_told_about_a_workspace_they_entered(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_member(
            session_factory, name="a-admin", tenant_id=TENANT_A, role="admin"
        )
        operator_id = await _make_member(
            session_factory,
            name="operator",
            tenant_id=TENANT_ZERO_ID,
            role="admin",
            user_role="admin",
        )
        token = _token(operator_id, "operator@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/counts")

        assert response.status_code == 200, response.text
        assert {row["id"] for row in response.json()} == {TENANT_ZERO_ID, TENANT_A}
        assert {row["id"]: row["users"] for row in response.json()}[TENANT_A] == 1

    async def test_a_workspace_named_by_someone_elses_claim_is_left_out(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        member_id = await _make_member(
            session_factory, name="member", tenant_id=TENANT_A, role="member"
        )
        token = _token(member_id, "member@example.invalid", TENANT_B)

        async with _client(_app(session_factory), token) as client:
            response = await client.get("/tenants/counts")

        assert response.status_code == 200, response.text
        assert [row["id"] for row in response.json()] == [TENANT_A]


class TestUsageRoute:
    async def _spend(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        tenant_id: str,
        amount: int,
    ) -> None:
        async with tenant_session(session_factory, tenant_id) as session:
            await UsageStore().record(
                session,
                tenant_id=tenant_id,
                metric=UsageMetric.MESSAGES,
                client_id=f"client-of-{tenant_id}",
                model="",
                amount=amount,
            )
            await session.commit()

    async def test_an_admin_sees_their_workspaces_usage_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        await self._spend(session_factory, TENANT_A, 3)
        await self._spend(session_factory, TENANT_B, 40)
        user_id = await _make_member(
            session_factory, name="usage-admin", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "usage-admin@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/usage", params=_window())

        assert response.status_code == 200
        assert response.json() == [
            {
                "metric": "messages",
                "client_id": f"client-of-{TENANT_A}",
                "client_name": None,
                "client_type": None,
                "model": "",
                "amount": 3,
            }
        ]

    async def test_a_plain_member_cannot_read_usage(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="usage-member", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "usage-member@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/usage", params=_window())

        assert response.status_code == 403

    async def test_an_admin_of_a_cannot_read_bs_usage(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        user_id = await _make_member(
            session_factory, name="usage-snoop", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "usage-snoop@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_B}/usage", params=_window())

        assert response.status_code == 403

    async def test_a_window_without_a_timezone_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="usage-naive", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "usage-naive@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(
                f"/tenants/{TENANT_A}/usage",
                params={"since": "2026-01-01T00:00:00", "until": "2026-01-02T00:00:00"},
            )

        assert response.status_code == 400
        assert "timezone" in response.json()["detail"]

    async def test_an_empty_window_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="usage-empty", tenant_id=TENANT_A, role="admin"
        )
        token = _token(user_id, "usage-empty@example.invalid", TENANT_A)
        window = _window()

        async with _client(_app(session_factory), token) as client:
            response = await client.get(
                f"/tenants/{TENANT_A}/usage",
                params={"since": window["until"], "until": window["since"]},
            )

        assert response.status_code == 400


class TestBudgetRoutes:
    async def _admin(
        self, session_factory: async_sessionmaker[AsyncSession], name: str
    ) -> tuple[str, str]:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name=name, tenant_id=TENANT_A, role="admin"
        )
        return user_id, _token(user_id, f"{name}@example.invalid", TENANT_A)

    async def test_an_admin_sets_a_budget_and_sees_its_spend(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id, token = await self._admin(session_factory, "budget-admin")
        agent_id, agent_name, _ = await _make_agent_with_key(
            session_factory, tenant_id=TENANT_A, owner_id=user_id
        )
        async with session_factory() as session:
            agent = await AgentStore().get(session, agent_id)
            assert agent is not None
            await UsageStore().record(
                session,
                tenant_id=TENANT_A,
                metric=UsageMetric.TURNS,
                client_id=agent.client_id,
                model="",
                amount=3,
            )
            await session.commit()

        async with _client(_app(session_factory), token) as client:
            created = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={
                    "agent_id": agent_id,
                    "metric": "turns",
                    "model": "",
                    "amount_limit": 3,
                    "period_hours": 24,
                },
            )
            listed = await client.get(f"/tenants/{TENANT_A}/budgets")

        assert created.status_code == 201
        body = created.json()
        assert body["agent_name"] == agent_name
        assert (body["spent"], body["exhausted"]) == (3, True)
        assert listed.json() == [body]

    async def test_a_second_budget_on_the_same_thing_is_a_conflict(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._admin(session_factory, "budget-twice")
        budget = {
            "agent_id": None,
            "metric": "messages",
            "model": "",
            "amount_limit": 100,
            "period_hours": 24,
        }

        async with _client(_app(session_factory), token) as client:
            first = await client.post(f"/tenants/{TENANT_A}/budgets", json=budget)
            second = await client.post(f"/tenants/{TENANT_A}/budgets", json=budget)

        assert first.status_code == 201
        assert second.status_code == 409

    @pytest.mark.parametrize("metric", ["messages", "turns"])
    async def test_a_budget_on_a_metric_counted_without_a_model_cannot_name_one(
        self, session_factory: async_sessionmaker[AsyncSession], metric: str
    ) -> None:
        _, token = await self._admin(session_factory, f"budget-model-{metric}")

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={
                    "agent_id": None,
                    "metric": metric,
                    "model": "some-model",
                    "amount_limit": 100,
                    "period_hours": 24,
                },
            )

        assert response.status_code == 422
        assert "not counted per model" in response.text

    @pytest.mark.parametrize(
        ("amount_limit", "period_hours"),
        [(2**53, 24), (100, 8785), (0, 24), (100, 0)],
    )
    async def test_a_budget_past_the_bounds_is_refused(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        amount_limit: int,
        period_hours: int,
    ) -> None:
        _, token = await self._admin(session_factory, "budget-bounds")
        limits = {"amount_limit": amount_limit, "period_hours": period_hours}

        async with _client(_app(session_factory), token) as client:
            created = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={"agent_id": None, "metric": "turns", "model": "", **limits},
            )
            within = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={
                    "agent_id": None,
                    "metric": "turns",
                    "model": "",
                    "amount_limit": 100,
                    "period_hours": 24,
                },
            )
            updated = await client.put(
                f"/tenants/{TENANT_A}/budgets/{within.json()['id']}", json=limits
            )

        assert created.status_code == 422
        assert within.status_code == 201
        assert updated.status_code == 422

    async def test_a_budget_for_another_workspaces_agent_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._admin(session_factory, "budget-foreign")
        await _make_tenant(session_factory, TENANT_B)
        their_owner = await _make_member(
            session_factory, name="budget-theirs", tenant_id=TENANT_B, role="admin"
        )
        their_agent, _, _ = await _make_agent_with_key(
            session_factory, tenant_id=TENANT_B, owner_id=their_owner
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={
                    "agent_id": their_agent,
                    "metric": "turns",
                    "model": "",
                    "amount_limit": 1,
                    "period_hours": 24,
                },
            )

        assert response.status_code == 404

    async def test_a_limit_that_is_not_positive_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._admin(session_factory, "budget-zero")

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={
                    "agent_id": None,
                    "metric": "turns",
                    "model": "",
                    "amount_limit": 0,
                    "period_hours": 24,
                },
            )

        assert response.status_code == 422

    async def test_an_admin_changes_and_removes_a_budget(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._admin(session_factory, "budget-edit")

        async with _client(_app(session_factory), token) as client:
            created = await client.post(
                f"/tenants/{TENANT_A}/budgets",
                json={
                    "agent_id": None,
                    "metric": "output_tokens",
                    "model": "some-model",
                    "amount_limit": 1000,
                    "period_hours": 24,
                },
            )
            budget_id = created.json()["id"]
            updated = await client.put(
                f"/tenants/{TENANT_A}/budgets/{budget_id}",
                json={"amount_limit": 5000, "period_hours": 168},
            )
            deleted = await client.delete(f"/tenants/{TENANT_A}/budgets/{budget_id}")
            again = await client.delete(f"/tenants/{TENANT_A}/budgets/{budget_id}")
            listed = await client.get(f"/tenants/{TENANT_A}/budgets")

        assert updated.status_code == 200
        assert (updated.json()["amount_limit"], updated.json()["period_hours"]) == (
            5000,
            168,
        )
        assert deleted.status_code == 204
        assert again.status_code == 404
        assert listed.json() == []

    async def test_a_plain_member_cannot_see_budgets(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="budget-member", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "budget-member@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/budgets")

        assert response.status_code == 403

    async def test_an_admin_of_a_cannot_touch_bs_budgets(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._admin(session_factory, "budget-snoop")
        await _make_tenant(session_factory, TENANT_B)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_B}/budgets")

        assert response.status_code == 403


class TestInvitationEmail:
    """An invitation naming an address is e-mailed there when a relay is
    configured, and stands whether or not the e-mail goes out — the response
    says which, so the admin knows when to share the link themselves."""

    async def _admin(
        self, session_factory: async_sessionmaker[AsyncSession], name: str
    ) -> str:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name=name, tenant_id=TENANT_A, role="admin"
        )
        return _token(user_id, f"{name}@example.invalid", TENANT_A)

    async def _invite(self, app: FastAPI, token: str, body: dict) -> httpx.Response:
        async with _client(app, token) as client:
            return await client.post(f"/tenants/{TENANT_A}/invitations", json=body)

    async def test_an_addressed_invitation_is_e_mailed_with_its_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        token = await self._admin(session_factory, "sender")
        mailer = _RecordingMailer()

        response = await self._invite(
            _app(session_factory, mailer=mailer),
            token,
            {"role": "admin", "email": "  New.Person@Example.com "},
        )

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["email_delivery"] == "sent"
        assert body["email"] == "new.person@example.com"
        [sent] = mailer.sent
        assert sent.to == "new.person@example.com"
        assert sent.link == f"https://switch.example.com/invite#token={body['token']}"
        assert sent.workspace_name == TENANT_A
        assert sent.inviter_name == "sender"
        assert sent.role == "admin"

    async def test_without_a_relay_the_invitation_stands_and_says_so(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        token = await self._admin(session_factory, "no-relay")

        with caplog.at_level("WARNING", logger="switch_core.gateway.tenants"):
            response = await self._invite(
                _app(session_factory), token, {"email": "someone@example.com"}
            )

        assert response.status_code == 201, response.text
        assert response.json()["email_delivery"] == "not_configured"
        assert "no SMTP relay is configured" in caplog.text
        async with tenant_session(session_factory, TENANT_A) as scoped:
            [invitation] = await InvitationStore().list_for_tenant(scoped)
            assert invitation.email == "someone@example.com"

    async def test_a_failed_send_still_leaves_a_usable_invitation(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        token = await self._admin(session_factory, "unlucky")
        app = _app(session_factory, mailer=_FailingMailer())

        response = await self._invite(app, token, {"email": "invitee@example.invalid"})

        assert response.status_code == 201, response.text
        assert response.json()["email_delivery"] == "failed"

        await _make_tenant(session_factory, TENANT_B)
        invitee_id = await _make_member(
            session_factory, name="invitee", tenant_id=TENANT_B, role="member"
        )
        async with _client(
            app, _token(invitee_id, "invitee@example.invalid", TENANT_B)
        ) as client:
            accepted = await client.post(
                "/invitations/accept", json={"token": response.json()["token"]}
            )
        assert accepted.status_code == 200, accepted.text

    async def test_a_link_invitation_sends_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        token = await self._admin(session_factory, "linker")
        mailer = _RecordingMailer()

        response = await self._invite(
            _app(session_factory, mailer=mailer), token, {"role": "member"}
        )

        assert response.status_code == 201, response.text
        assert response.json()["email_delivery"] == "not_requested"
        assert mailer.sent == []

    @pytest.mark.parametrize(
        "email", ["not-an-address", "a@b", "two@@example.com", "sp ace@example.com"]
    )
    async def test_something_that_is_not_an_address_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession], email: str
    ) -> None:
        token = await self._admin(session_factory, "typist")

        response = await self._invite(
            _app(session_factory, mailer=_RecordingMailer()), token, {"email": email}
        )

        assert response.status_code == 422

    async def test_the_daily_cap_refuses_before_minting_anything(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        token = await self._admin(session_factory, "prolific")
        mailer = _RecordingMailer()
        app = _app(session_factory, mailer=mailer, invite_emails_per_day=2)

        for n in range(2):
            ok = await self._invite(app, token, {"email": f"p{n}@example.com"})
            assert ok.status_code == 201, ok.text
        link = await self._invite(app, token, {"role": "member"})
        over = await self._invite(app, token, {"email": "p2@example.com"})

        assert link.status_code == 201, "link invitations are not capped"
        assert over.status_code == 429
        assert "daily limit" in over.json()["detail"]
        assert len(mailer.sent) == 2
        async with tenant_session(session_factory, TENANT_A) as scoped:
            assert len(await InvitationStore().list_for_tenant(scoped)) == 3

    async def test_an_operator_is_not_capped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        async with session_factory() as session:
            operator = User(
                name="operator", email="operator@example.invalid", role="admin"
            )
            session.add(operator)
            await session.flush()
            session.add(
                TenantMember(tenant_id=TENANT_A, user_id=operator.id, role="admin")
            )
            await session.commit()
            operator_id = operator.id
        token = _token(operator_id, "operator@example.invalid", TENANT_A)
        app = _app(session_factory, mailer=_RecordingMailer(), invite_emails_per_day=1)

        for n in range(2):
            response = await self._invite(app, token, {"email": f"o{n}@example.com"})
            assert response.status_code == 201, response.text


class TestJoiningByDomain:
    async def _admin(
        self, session_factory: async_sessionmaker[AsyncSession], email: str
    ) -> tuple[str, str]:
        """An admin of workspace A, and their cookie."""
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name=email, tenant_id=TENANT_A, role="admin", email=email
        )
        return user_id, _token(user_id, email, TENANT_A)

    async def _outsider(
        self, session_factory: async_sessionmaker[AsyncSession], email: str
    ) -> tuple[str, str]:
        """A signed-in person in workspace B, and their cookie."""
        async with session_factory() as session:
            if await session.get(Tenant, TENANT_B) is None:
                session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
                await session.commit()
        user_id = await _make_member(
            session_factory, name=email, tenant_id=TENANT_B, role="member", email=email
        )
        return user_id, _token(user_id, email, TENANT_B)

    async def test_an_admin_opens_the_workspace_to_their_own_domain(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id, cookie = await self._admin(session_factory, "ada@Acme.example")

        async with _client(_app(session_factory), cookie) as client:
            before = await client.get(f"/tenants/{TENANT_A}/join-domains")
            added = await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": " ACME.example "}
            )
            again = await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "acme.example"}
            )
            after = await client.get(f"/tenants/{TENANT_A}/join-domains")

        assert before.status_code == 200, before.text
        assert before.json() == {
            "domains": [],
            "own_domain": "acme.example",
            "own_domain_refusal": None,
        }
        assert added.status_code == 201, added.text
        assert added.json()["domain"] == "acme.example"
        assert added.json()["created_by"] == admin_id
        assert again.status_code == 409
        assert [d["domain"] for d in after.json()["domains"]] == ["acme.example"]

    async def test_another_domain_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _admin_id, cookie = await self._admin(session_factory, "ada@acme.example")

        async with _client(_app(session_factory), cookie) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "rival.example"}
            )

        assert response.status_code == 400
        assert "your own address, acme.example" in response.json()["detail"]

    async def test_a_public_e_mail_provider_is_refused_even_as_your_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _admin_id, cookie = await self._admin(session_factory, "ada@gmail.com")

        async with _client(_app(session_factory), cookie) as client:
            listed = await client.get(f"/tenants/{TENANT_A}/join-domains")
            response = await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "gmail.com"}
            )

        assert "public e-mail provider" in listed.json()["own_domain_refusal"]
        assert response.status_code == 400
        assert "public e-mail provider" in response.json()["detail"]

    async def test_a_member_cannot_open_the_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        member_id = await _make_member(
            session_factory,
            name="mo",
            tenant_id=TENANT_A,
            role="member",
            email="mo@acme.example",
        )

        async with _client(
            _app(session_factory), _token(member_id, "mo@acme.example", TENANT_A)
        ) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "acme.example"}
            )

        assert response.status_code == 403

    async def test_someone_at_the_domain_sees_and_joins_it_as_a_member(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _admin_id, admin_cookie = await self._admin(session_factory, "ada@acme.example")
        joiner_id, cookie = await self._outsider(session_factory, "bo@ACME.example")
        _other_id, other_cookie = await self._outsider(
            session_factory, "cy@elsewhere.example"
        )

        async with _client(_app(session_factory), admin_cookie) as client:
            await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "acme.example"}
            )
        async with _client(_app(session_factory), other_cookie) as client:
            not_offered = await client.get("/joinable-tenants")
            not_joined = await client.post(f"/joinable-tenants/{TENANT_A}/join")
        async with _client(_app(session_factory), cookie) as client:
            offered = await client.get("/joinable-tenants")
            joined = await client.post(f"/joinable-tenants/{TENANT_A}/join")
            afterwards = await client.get("/joinable-tenants")

        assert not_offered.json() == []
        assert not_joined.status_code == 404
        assert offered.status_code == 200, offered.text
        assert offered.json() == [
            {
                "tenant_id": TENANT_A,
                "tenant_slug": TENANT_A,
                "tenant_name": TENANT_A,
                "domain": "acme.example",
            }
        ]
        assert joined.status_code == 200, joined.text
        assert joined.json()["role"] == "member"
        assert _tenant_claim(joined) == TENANT_A
        assert await _last_tenant_id(session_factory, joiner_id) == TENANT_A
        assert afterwards.json() == []
        async with tenant_session(session_factory, TENANT_A) as session:
            membership = await session.get(TenantMember, (TENANT_A, joiner_id))
            assert membership is not None
            assert membership.role == "member"

    async def test_joining_again_keeps_the_role_you_have(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        admin_id, cookie = await self._admin(session_factory, "ada@acme.example")

        async with _client(_app(session_factory), cookie) as client:
            await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "acme.example"}
            )
            response = await client.post(f"/joinable-tenants/{TENANT_A}/join")

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "admin"

    async def test_closing_the_domain_stops_new_joins(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _admin_id, admin_cookie = await self._admin(session_factory, "ada@acme.example")
        _joiner_id, cookie = await self._outsider(session_factory, "bo@acme.example")

        async with _client(_app(session_factory), admin_cookie) as client:
            await client.post(
                f"/tenants/{TENANT_A}/join-domains", json={"domain": "acme.example"}
            )
            removed = await client.delete(
                f"/tenants/{TENANT_A}/join-domains/acme.example"
            )
            missing = await client.delete(
                f"/tenants/{TENANT_A}/join-domains/acme.example"
            )
        async with _client(_app(session_factory), cookie) as client:
            offered = await client.get("/joinable-tenants")
            joined = await client.post(f"/joinable-tenants/{TENANT_A}/join")

        assert removed.status_code == 204
        assert missing.status_code == 404
        assert offered.json() == []
        assert joined.status_code == 404


class TestRetentionRoutes:
    async def _member(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        name: str,
        role: str,
    ) -> tuple[str, str]:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name=name, tenant_id=TENANT_A, role=role
        )
        return user_id, _token(user_id, f"{name}@example.invalid", TENANT_A)

    async def _audit_actions(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> list[tuple[str, dict | None]]:
        async with tenant_session(session_factory, TENANT_A) as session:
            rows = await session.execute(
                select(AuditEvent.action, AuditEvent.details)
                .where(AuditEvent.tenant_id == TENANT_A)
                .order_by(AuditEvent.occurred_at)
            )
            return [(action, details) for action, details in rows.all()]

    async def test_a_new_workspace_keeps_messages_forever(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._member(session_factory, "keep-forever", "admin")

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/retention")

        assert response.status_code == 200
        assert response.json()["message_retention_days"] is None

    async def test_an_admin_sets_changes_and_clears_the_window_and_each_is_audited(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id, token = await self._member(session_factory, "retention-admin", "admin")

        async with _client(_app(session_factory), token) as client:
            first = await client.put(
                f"/tenants/{TENANT_A}/retention", json={"message_retention_days": 90}
            )
            second = await client.put(
                f"/tenants/{TENANT_A}/retention", json={"message_retention_days": 30}
            )
            read = await client.get(f"/tenants/{TENANT_A}/retention")
            cleared = await client.delete(f"/tenants/{TENANT_A}/retention")
            cleared_again = await client.delete(f"/tenants/{TENANT_A}/retention")

        assert first.status_code == 200
        assert first.json()["message_retention_days"] == 90
        assert read.json()["message_retention_days"] == 30
        assert read.json()["updated_by_user_id"] == user_id
        assert (
            second.status_code
            == cleared.status_code
            == cleared_again.status_code
            == 200
        )
        assert cleared.json()["message_retention_days"] is None
        assert await self._audit_actions(session_factory) == [
            (
                "retention_policy.set",
                {"message_retention_days": 90, "previous_message_retention_days": None},
            ),
            (
                "retention_policy.set",
                {"message_retention_days": 30, "previous_message_retention_days": 90},
            ),
            ("retention_policy.cleared", {"previous_message_retention_days": 30}),
        ]

    async def test_a_member_can_neither_read_nor_change_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._member(session_factory, "retention-member", "member")

        async with _client(_app(session_factory), token) as client:
            read = await client.get(f"/tenants/{TENANT_A}/retention")
            written = await client.put(
                f"/tenants/{TENANT_A}/retention", json={"message_retention_days": 30}
            )

        assert read.status_code == 403
        assert written.status_code == 403

    async def test_an_operator_without_admin_membership_cannot_set_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        operator_id = await _make_member(
            session_factory,
            name="retention-operator",
            tenant_id=TENANT_A,
            role="member",
            user_role="admin",
        )
        operator = create_jwt(
            operator_id,
            "retention-operator@example.invalid",
            "admin",
            _KEYRING,
            TENANT_A,
            session_version=0,
            auth_time=datetime.now(UTC),
        )

        async with _client(_app(session_factory), operator) as client:
            read = await client.get(f"/tenants/{TENANT_A}/retention")
            written = await client.put(
                f"/tenants/{TENANT_A}/retention", json={"message_retention_days": 30}
            )

        assert read.status_code == 200
        assert written.status_code == 403
        assert written.json()["detail"] == (
            "Only a workspace admin may set when messages are deleted"
        )

    @pytest.mark.parametrize("days", [0, 3651])
    async def test_a_window_out_of_range_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession], days: int
    ) -> None:
        _, token = await self._member(
            session_factory, f"retention-range-{days}", "admin"
        )

        async with _client(_app(session_factory), token) as client:
            response = await client.put(
                f"/tenants/{TENANT_A}/retention", json={"message_retention_days": days}
            )

        assert response.status_code == 422

    async def test_another_workspace_in_the_path_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._member(session_factory, "retention-cross", "admin")
        await _make_tenant(session_factory, TENANT_B)

        async with _client(_app(session_factory), token) as client:
            response = await client.put(
                f"/tenants/{TENANT_B}/retention", json={"message_retention_days": 30}
            )

        assert response.status_code == 403

    async def test_the_preview_counts_only_messages_older_than_the_window(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, token = await self._member(session_factory, "retention-preview", "admin")
        now = datetime.now(UTC)
        async with tenant_session(session_factory, TENANT_A) as session:
            room = Room(
                transport_room_id=f"!preview-{uuid.uuid4().hex[:8]}:test",
                name="preview",
                description="preview",
            )
            session.add(room)
            await session.flush()
            for index, age in enumerate((100, 40, 1)):
                await MessageStore().create(
                    session,
                    Message(
                        room_id=room.id,
                        transport_event_id=f"$preview-{index}",
                        sender_id="@sender:test",
                        event_type="m.room.message",
                        msgtype="m.text",
                        body="hello",
                        content={"msgtype": "m.text", "body": "hello"},
                        sent_at=now - timedelta(days=age),
                    ),
                    [],
                )
            await session.commit()

        async with _client(_app(session_factory), token) as client:
            ninety = await client.get(f"/tenants/{TENANT_A}/retention/preview?days=90")
            thirty = await client.get(f"/tenants/{TENANT_A}/retention/preview?days=30")

        assert ninety.json() == {"message_retention_days": 90, "messages_to_delete": 1}
        assert thirty.json() == {"message_retention_days": 30, "messages_to_delete": 2}


class TestErasureRoutes:
    async def _member(
        self, session_factory: async_sessionmaker[AsyncSession], name: str, role: str
    ) -> str:
        user_id = await _make_member(
            session_factory, name=name, tenant_id=TENANT_A, role=role
        )
        return _token(user_id, f"{name}@example.invalid", TENANT_A)

    async def _person(
        self, session_factory: async_sessionmaker[AsyncSession], username: str
    ) -> str:
        async with tenant_session(session_factory, TENANT_A) as session:
            bridge_client = Client(
                transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
                display_name="bridge",
                type="bridge",
            )
            person_client = Client(
                transport_user_id=f"@{username}-{uuid.uuid4().hex[:8]}:test",
                display_name=username,
                type="user",
            )
            session.add_all([bridge_client, person_client])
            await session.flush()
            bridge = CollaborationBridge(
                type="slack",
                display_name="Acme Slack",
                client_id=bridge_client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            person = ExternalUser(
                bridge_id=bridge.id,
                external_user_id=f"U-{username}",
                external_username=username,
                client_id=person_client.id,
            )
            session.add(person)
            await session.commit()
            return person.id

    async def test_an_admin_lists_people_queues_an_erasure_and_sees_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        token = await self._member(session_factory, "erase-admin", "admin")
        person_id = await self._person(session_factory, "ana")

        async with _client(_app(session_factory), token) as client:
            people = await client.get(f"/tenants/{TENANT_A}/people")
            queued = await client.post(
                f"/tenants/{TENANT_A}/erasures",
                json={"external_user_ids": [person_id]},
            )
            again = await client.post(
                f"/tenants/{TENANT_A}/erasures",
                json={"external_user_ids": [person_id]},
            )
            listed = await client.get(f"/tenants/{TENANT_A}/erasures")

        assert people.status_code == 200
        assert [
            (p["username"], p["platform"], p["message_count"]) for p in people.json()
        ] == [("ana", "slack", 0)]
        assert queued.status_code == 202
        assert queued.json()["state"] == "queued"
        assert queued.json()["identities"] == 1
        assert again.status_code == 409
        assert [e["id"] for e in listed.json()] == [queued.json()["id"]]
        async with tenant_session(session_factory, TENANT_A) as session:
            actions = (
                await session.execute(
                    select(AuditEvent.action, AuditEvent.details).where(
                        AuditEvent.tenant_id == TENANT_A
                    )
                )
            ).all()
        assert actions == [
            (
                "person_erasure.requested",
                {
                    "external_user_ids": [person_id],
                    "former_participants": 0,
                    "member_client_ids": [],
                },
            )
        ]

    async def test_a_former_participant_is_listed_and_erased(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        token = await self._member(session_factory, "erase-former", "admin")
        sender_id = f"@switch-slack-{uuid.uuid4()}-dee:test"
        async with tenant_session(session_factory, TENANT_A) as session:
            room = Room(
                transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
                name="r",
                description="r",
            )
            session.add(room)
            await session.flush()
            await MessageStore().create(
                session,
                Message(
                    room_id=room.id,
                    transport_event_id="$dee",
                    sender_id=sender_id,
                    sender_name="dee",
                    event_type="m.room.message",
                    msgtype="m.text",
                    body="hi",
                    content={"msgtype": "m.text", "body": "hi"},
                ),
                [],
            )
            await session.commit()

        async with _client(_app(session_factory), token) as client:
            people = await client.get(f"/tenants/{TENANT_A}/people")
            empty = await client.post(f"/tenants/{TENANT_A}/erasures", json={})
            queued = await client.post(
                f"/tenants/{TENANT_A}/erasures",
                json={"former_sender_ids": [sender_id]},
            )

        assert [
            (p["id"], p["kind"], p["username"], p["bridge_name"], p["message_count"])
            for p in people.json()
        ] == [(sender_id, "former", "dee", None, 1)]
        assert empty.status_code == 422
        assert queued.status_code == 202
        assert queued.json()["identities"] == 1

    async def test_a_switch_console_member_is_listed_and_erased(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        token = await self._member(session_factory, "erase-console", "admin")
        async with tenant_session(session_factory, TENANT_A) as session:
            member = Client(
                transport_user_id=f"@switch-member-{uuid.uuid4()}:test",
                display_name="Former member",
                type="member",
            )
            session.add(member)
            await session.commit()
            member_id = member.id

        async with _client(_app(session_factory), token) as client:
            people = await client.get(f"/tenants/{TENANT_A}/people")
            queued = await client.post(
                f"/tenants/{TENANT_A}/erasures",
                json={"member_client_ids": [member_id]},
            )

        assert [
            (p["id"], p["kind"], p["username"], p["platform"], p["message_count"])
            for p in people.json()
        ] == [(member_id, "member", "Former member", "switch", 0)]
        assert queued.status_code == 202
        assert queued.json()["identities"] == 1

    async def test_a_member_or_an_operator_without_admin_membership_cannot_erase(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        member = await self._member(session_factory, "erase-member", "member")
        operator_id = await _make_member(
            session_factory,
            name="erase-operator",
            tenant_id=TENANT_A,
            role="member",
            user_role="admin",
        )
        operator = create_jwt(
            operator_id,
            "erase-operator@example.invalid",
            "admin",
            _KEYRING,
            TENANT_A,
            session_version=0,
            auth_time=datetime.now(UTC),
        )
        person_id = await self._person(session_factory, "ana")

        for token in (member, operator):
            async with _client(_app(session_factory), token) as client:
                people = await client.get(f"/tenants/{TENANT_A}/people")
                queued = await client.post(
                    f"/tenants/{TENANT_A}/erasures",
                    json={"external_user_ids": [person_id]},
                )
            assert people.status_code == 403
            assert queued.status_code == 403

    async def test_a_person_from_another_workspace_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_tenant(session_factory, TENANT_B)
        token = await self._member(session_factory, "erase-cross", "admin")
        async with tenant_session(session_factory, TENANT_B) as session:
            other_client = Client(
                transport_user_id=f"@b-{uuid.uuid4().hex[:8]}:test",
                display_name="b",
                type="bridge",
            )
            person_client = Client(
                transport_user_id=f"@p-{uuid.uuid4().hex[:8]}:test",
                display_name="p",
                type="user",
            )
            session.add_all([other_client, person_client])
            await session.flush()
            bridge = CollaborationBridge(
                type="slack",
                display_name="B",
                client_id=other_client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            person = ExternalUser(
                bridge_id=bridge.id,
                external_user_id="U-b",
                external_username="b",
                client_id=person_client.id,
            )
            session.add(person)
            await session.commit()
            other_person = person.id

        async with _client(_app(session_factory), token) as client:
            response = await client.post(
                f"/tenants/{TENANT_A}/erasures",
                json={"external_user_ids": [other_person]},
            )

        assert response.status_code == 404
