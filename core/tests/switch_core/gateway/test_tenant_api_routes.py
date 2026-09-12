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

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    Invitation,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.tenants import router as tenants_router

_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
TENANT_A = "tenant-api-routes-a"
TENANT_B = "tenant-api-routes-b"


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_tenant(self, name: str, slug: str) -> Tenant:
        tenant = Tenant(id=str(uuid.uuid4()), name=name, slug=slug)
        async with tenant_session(self._session_factory, tenant.id) as session:
            session.add(tenant)
            await session.commit()
        return tenant


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
    app.dependency_overrides[gw_deps.get_agent_store] = lambda: AgentStore()
    app.dependency_overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    app.dependency_overrides[gw_deps.get_invitation_store] = lambda: InvitationStore()
    app.dependency_overrides[gw_deps.get_protocol] = lambda: _fake_protocol()
    app.dependency_overrides[gw_deps.get_client_lifecycle] = lambda: (
        client_lifecycle or _FakeClientLifecycle(session_factory)
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=_SECRET,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
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
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=email or f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role=role))
        await session.commit()
        return user.id


def _token(user_id: str, email: str, tenant_id: str) -> str:
    return create_jwt(user_id, email, "user", _SECRET, tenant_id)


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
) -> tuple[str, str]:
    """An agent owned by `owner_id`, plus the `agents`-type key backing it.

    Returns `(agent_id, key_hash)`. The agent's own client and api_key rows
    are constructed first — `agents.client_id` and `agents.api_key_id` are
    both foreign keys, not free-form strings.
    """
    key_hash = uuid.uuid4().hex
    async with session_factory() as session:
        client = Client(
            tenant_id=tenant_id,
            matrix_user_id=f"@bot-{uuid.uuid4().hex[:8]}:test",
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
            name=f"agent-{uuid.uuid4().hex[:8]}",
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
        return agent.id, key_hash


class TestCreateTenant:
    async def test_creating_a_tenant_makes_the_caller_its_owner(
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
        assert body["role"] == "owner"

        async with session_factory() as session:
            membership = await session.get(TenantMember, (body["id"], user_id))
            assert membership is not None
            assert membership.role == "owner"

    async def test_a_taken_slug_is_409_not_a_silent_suffix(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="second-founder", tenant_id=TENANT_A, role="member"
        )
        token = _token(user_id, "second-founder@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            first = await client.post("/tenants", json={"name": "Widgets Inc"})
            assert first.status_code == 201, first.text
            second = await client.post("/tenants", json={"name": "Widgets Inc"})

        assert second.status_code == 409

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

    async def test_an_owner_can_mint_an_invitation_to_their_own_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        user_id = await _make_member(
            session_factory, name="a-owner", tenant_id=TENANT_A, role="owner"
        )
        token = _token(user_id, "a-owner@example.invalid", TENANT_A)

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
            session_factory, name="inviter", tenant_id=TENANT_A, role="owner"
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
            response = await client.post(f"/invitations/{token}/accept")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["id"] == TENANT_A
        assert body["role"] == "admin"

        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, invitee_id))
            assert membership is not None
            assert membership.role == "admin"

    async def test_accepting_twice_fails_the_second_time(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="inviter2", tenant_id=TENANT_A, role="owner"
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
            first = await client.post(f"/invitations/{token}/accept")
        assert first.status_code == 200, first.text

        async with _client(
            app, _token(second_invitee, "second-invitee@example.invalid", TENANT_B)
        ) as client:
            second = await client.post(f"/invitations/{token}/accept")

        assert second.status_code == 403
        assert "used" in second.json()["detail"].lower()

        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, second_invitee)) is None

    async def test_a_revoked_invitation_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="revoker", tenant_id=TENANT_A, role="owner"
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
            response = await client.post(f"/invitations/{token}/accept")

        assert response.status_code == 403
        assert "revoked" in response.json()["detail"].lower()

    async def test_an_expired_invitation_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="expiry-setter", tenant_id=TENANT_A, role="owner"
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
            response = await client.post(f"/invitations/{token}/accept")

        assert response.status_code == 403
        assert "expired" in response.json()["detail"].lower()

    async def test_an_email_bound_invitation_refuses_a_different_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="picky-inviter", tenant_id=TENANT_A, role="owner"
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
            response = await client.post(f"/invitations/{token}/accept")

        assert response.status_code == 403
        assert "email" in response.json()["detail"].lower()

    async def test_an_email_bound_invitation_accepts_the_addressed_email(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        admin_id = await _make_member(
            session_factory, name="picky-inviter2", tenant_id=TENANT_A, role="owner"
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
            response = await client.post(f"/invitations/{token}/accept")

        assert response.status_code == 200, response.text


class TestMemberRoutes:
    async def test_listing_shows_every_member_and_their_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="list-owner", tenant_id=TENANT_A, role="owner"
        )
        await _make_member(
            session_factory, name="list-member", tenant_id=TENANT_A, role="member"
        )
        token = _token(owner_id, "list-owner@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.get(f"/tenants/{TENANT_A}/members")

        assert response.status_code == 200, response.text
        roles = {row["name"]: row["role"] for row in response.json()}
        assert roles == {"list-owner": "owner", "list-member": "member"}

    async def test_the_last_owner_cannot_be_demoted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="sole-owner", tenant_id=TENANT_A, role="owner"
        )
        token = _token(owner_id, "sole-owner@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{owner_id}", json={"role": "member"}
            )

        assert response.status_code == 409

        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, owner_id))
            assert membership is not None
            assert membership.role == "owner"

    async def test_an_owner_can_be_demoted_when_another_owner_remains(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="owner-one", tenant_id=TENANT_A, role="owner"
        )
        other_owner_id = await _make_member(
            session_factory, name="owner-two", tenant_id=TENANT_A, role="owner"
        )
        token = _token(owner_id, "owner-one@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.patch(
                f"/tenants/{TENANT_A}/members/{other_owner_id}",
                json={"role": "member"},
            )

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "member"

    async def test_the_last_owner_cannot_be_removed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="undeletable-owner", tenant_id=TENANT_A, role="owner"
        )
        token = _token(owner_id, "undeletable-owner@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{owner_id}")

        assert response.status_code == 409

        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, owner_id)) is not None

    async def test_removing_a_member_deletes_their_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="remover", tenant_id=TENANT_A, role="owner"
        )
        target_id = await _make_member(
            session_factory, name="removed", tenant_id=TENANT_A, role="member"
        )
        token = _token(owner_id, "remover@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")

        assert response.status_code == 200, response.text

        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, target_id)) is None

    async def test_removing_a_member_stops_their_api_key_working(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The bite test: after removal, the credential the member minted in
        this tenant no longer resolves to anything — not merely hidden, gone.
        A live bearer-auth attempt with the same hash would fail at the very
        first lookup `ApiKeyStore.get_by_hash` performs.
        """
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="key-remover", tenant_id=TENANT_A, role="owner"
        )
        target_id = await _make_member(
            session_factory, name="key-holder", tenant_id=TENANT_A, role="member"
        )
        key_hash = await _make_api_key(
            session_factory, tenant_id=TENANT_A, user_id=target_id
        )
        token = _token(owner_id, "key-remover@example.invalid", TENANT_A)

        async with session_factory() as session:
            assert await ApiKeyStore().get_by_hash(session, key_hash) is not None

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")
        assert response.status_code == 200, response.text

        async with session_factory() as session:
            assert await ApiKeyStore().get_by_hash(session, key_hash) is None

    async def test_removing_a_member_deletes_the_agents_they_own_here(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner_id = await _make_member(
            session_factory, name="agent-remover", tenant_id=TENANT_A, role="owner"
        )
        target_id = await _make_member(
            session_factory, name="agent-owner", tenant_id=TENANT_A, role="member"
        )
        agent_id, agent_key_hash = await _make_agent_with_key(
            session_factory, tenant_id=TENANT_A, owner_id=target_id
        )
        token = _token(owner_id, "agent-remover@example.invalid", TENANT_A)

        async with _client(_app(session_factory), token) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{target_id}")
        assert response.status_code == 200, response.text

        async with session_factory() as session:
            assert await AgentStore().get(session, agent_id) is None
            assert await ApiKeyStore().get_by_hash(session, agent_key_hash) is None

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
