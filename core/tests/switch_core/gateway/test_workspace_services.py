"""A workspace admin's switch per service, through the real gateway on Postgres.

Signed in with real session cookies. Switching off reaches other people's
running sessions, so the list says who it touches, and GitHub's live tokens are
revoked before the switch answers. That the routes are absent without the
`service_connections` flag is checked in `test_app_route_mounting.py`.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ServiceAdapterError
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    STORE,
    agent_with_key,
    build_service_harness,
    connect,
    grant_directly,
    services_on_by_default,
)
from tests.switch_core.gateway.test_tenant_api_routes import TENANT_A, _make_tenant
from tests.switch_core.management.harness import Harness, add_member, cookies_for

SERVICES = "/gateway/workspace/services"


@pytest.fixture
def vendor() -> FakeVendor:
    return FakeVendor()


@pytest.fixture
def harness(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> Harness:
    return build_service_harness(session_factory, vendor, workspace_gate=True)[0]


async def _person(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    *,
    member_role: str | None,
    user_role: str = "user",
) -> User:
    """A user, a member of tenant zero in `member_role` (None: not a member)."""
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.invalid", role=user_role)
        session.add(user)
        await session.flush()
        if member_role is not None:
            session.add(
                TenantMember(
                    tenant_id=TENANT_ZERO_ID, user_id=user.id, role=member_role
                )
            )
        await session.commit()
        return user


async def _put(harness: Harness, user: User | None, service: str, body: object):
    async with harness.client() as client:
        return await client.put(
            f"{SERVICES}/{service}",
            json=body,
            cookies={} if user is None else cookies_for(user),
        )


async def _get(harness: Harness, user: User | None):
    async with harness.client() as client:
        return await client.get(
            SERVICES, cookies={} if user is None else cookies_for(user)
        )


def _by_slug(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {service["slug"]: service for service in response.json()["services"]}


async def _granted(
    session_factory: async_sessionmaker[AsyncSession],
    owner: User,
    agent_id: str,
    service: str,
) -> ServiceGrant:
    """A connection to `service` and a grant on it, so a token issued under it
    is live rather than orphaned."""
    async with session_factory() as session:
        await STORE.save_connection(
            session,
            user_id=owner.id,
            service=service,
            consent="write",
            granted_scopes=[],
            account_id=f"{service}-account",
            external_identity=owner.name,
            encrypted_secret=TEST_KEYRING.encrypt("{}"),
            oauth_client_id=None,
        )
        grant = await STORE.save_grant(
            session,
            agent_id=agent_id,
            owner_id=owner.id,
            service=service,
            access="write",
            tool_mode="deny",
            tools=[],
            resources={},
            account_id=f"{service}-account",
            created_by=owner.id,
        )
        await session.commit()
        return grant


def _issuance(
    grant: ServiceGrant | None,
    owner_id: str,
    service: str,
    token: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> ServiceTokenIssuance:
    return ServiceTokenIssuance(
        tenant_id=tenant_id,
        grant_id=str(uuid.uuid4()) if grant is None else grant.id,
        agent_id=str(uuid.uuid4()) if grant is None else grant.agent_id,
        owner_id=owner_id,
        service=service,
        principal="agent_key",
        controller_id=None,
        permissions={},
        resources={},
        expires_at=datetime.now(UTC) + timedelta(minutes=50),
        token_sha256=hashlib.sha256(token.encode()).hexdigest(),
        encrypted_token=TEST_KEYRING.encrypt(token),
        revoke_requested=False,
        attempts=0,
    )


async def _issuances(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> dict[str, ServiceTokenIssuance]:
    async with tenant_session(session_factory, tenant_id) as session:
        rows = await session.scalars(select(ServiceTokenIssuance))
        by_hash = {row.token_sha256: row for row in rows}
    return {
        token: by_hash[hashlib.sha256(token.encode()).hexdigest()]
        for token in ("ghs_here", "other_service", "ghs_elsewhere")
        if hashlib.sha256(token.encode()).hexdigest() in by_hash
    }


class TestWhoMayCall:
    @pytest.mark.parametrize(
        ("member_role", "user_role", "expected"),
        [
            ("member", "user", 403),
            ("admin", "user", 200),
            ("owner", "user", 200),
            ("member", "admin", 200),
            # The gateway binds only a workspace the caller belongs to, the
            # operator included: the operator bit lifts a member, it does not
            # reach into a workspace from outside.
            (None, "admin", 403),
        ],
        ids=["member", "admin", "owner", "operator-as-member", "operator-not-a-member"],
    )
    async def test_only_admins_owners_and_the_operator(
        self, harness: Harness, member_role, user_role, expected
    ) -> None:
        user = await _person(
            harness.session_factory,
            f"caller-{uuid.uuid4().hex[:6]}",
            member_role=member_role,
            user_role=user_role,
        )
        listed = await _get(harness, user)
        switched = await _put(harness, user, "datadog", {"enabled": False})
        assert (listed.status_code, switched.status_code) == (expected, expected)

    async def test_signed_out_is_unauthorized(self, harness: Harness) -> None:
        assert (await _get(harness, None)).status_code == 401
        assert (
            await _put(harness, None, "datadog", {"enabled": False})
        ).status_code == 401


class TestRequests:
    @pytest.mark.parametrize("service", ["nowhere", "asana"])
    async def test_an_unknown_or_placeholder_service_is_not_found(
        self, harness: Harness, service: str
    ) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        response = await _put(harness, admin, service, {"enabled": False})
        assert response.status_code == 404
        assert response.json()["detail"] == f"No service named {service!r}."

    @pytest.mark.parametrize(
        "body", [{}, {"enabled": "no"}, {"enabled": False, "extra": 1}]
    )
    async def test_a_bad_body_is_refused(self, harness: Harness, body) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        assert (await _put(harness, admin, "datadog", body)).status_code == 422

    async def test_the_same_switch_twice_is_no_error(self, harness: Harness) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        for _ in range(2):
            response = await _put(harness, admin, "datadog", {"enabled": False})
            assert response.status_code == 200, response.text


class TestResults:
    @pytest.mark.parametrize("on_by_default", [False, True])
    async def test_untouched_services_take_the_workspaces_default_with_nobody_named(
        self, harness: Harness, on_by_default: bool
    ) -> None:
        if on_by_default:
            await services_on_by_default(harness.session_factory)
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        services = _by_slug(await _get(harness, admin))
        assert set(services) == {
            "airtable",
            "atlassian",
            "datadog",
            "github",
            "google-workspace",
        }
        assert services["datadog"] == {
            "slug": "datadog",
            "name": "Datadog",
            "enabled": on_by_default,
            "updated_by_name": None,
            "updated_at": None,
            "connected_members": 0,
            "granted_agents": 0,
        }

    async def test_a_switch_round_trips_naming_the_admin_with_one_audit_row_each(
        self, harness: Harness
    ) -> None:
        admin = await _person(harness.session_factory, "ines", member_role="admin")
        off = await _put(harness, admin, "datadog", {"enabled": False})
        assert off.json() == {"slug": "datadog", "enabled": False, "warning": None}
        datadog = _by_slug(await _get(harness, admin))["datadog"]
        assert (datadog["enabled"], datadog["updated_by_name"]) == (False, "ines")
        assert datadog["updated_at"] is not None

        await _put(harness, admin, "datadog", {"enabled": True})
        assert _by_slug(await _get(harness, admin))["datadog"]["enabled"] is True

        async with harness.session_factory() as session:
            events = list(
                await session.scalars(
                    select(AuditEvent).order_by(AuditEvent.occurred_at, AuditEvent.id)
                )
            )
        assert [
            (event.action, event.actor_user_id, event.target_id, event.details)
            for event in events
        ] == [
            (
                AuditAction.WORKSPACE_SERVICE_DISABLED.value,
                admin.id,
                "datadog",
                {"service": "datadog"},
            ),
            (
                AuditAction.WORKSPACE_SERVICE_ENABLED.value,
                admin.id,
                "datadog",
                {"service": "datadog"},
            ),
        ]

    async def test_the_counts_say_who_switching_off_reaches(
        self, harness: Harness
    ) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        await connect(harness.session_factory, ada.id, account_id="1001")
        await connect(harness.session_factory, bob.id, account_id="1002")
        agent_id, _ = await agent_with_key(harness.session_factory, ada, "builder")
        await grant_directly(harness.session_factory, agent_id, ada.id)

        services = _by_slug(await _get(harness, admin))

        assert (
            services["github"]["connected_members"],
            services["github"]["granted_agents"],
        ) == (2, 1)
        assert (
            services["atlassian"]["connected_members"],
            services["atlassian"]["granted_agents"],
        ) == (0, 0)

    async def test_a_connection_that_needs_reconnecting_is_not_counted(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        """Counted as each member's own Connectors page reads it: one marked
        for reconnecting, and one made through an app since replaced, reach
        nothing until reconnected."""
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        cy = await add_member(harness.session_factory, "cy")
        for person, account in ((ada, "1001"), (bob, "1002"), (cy, "1003")):
            await connect(harness.session_factory, person.id, account_id=account)
        async with harness.session_factory() as session:
            await STORE.mark_needs_reauthorization(
                session, bob.id, "github", "refresh_refused"
            )
            await session.execute(
                update(ServiceConnection)
                .where(ServiceConnection.user_id == cy.id)
                .values(oauth_client_id="old-client")
            )
            await session.commit()
        vendor.client_id = "new-client"

        services = _by_slug(await _get(harness, admin))

        assert services["github"]["connected_members"] == 1


class TestSwitchingOff:
    async def test_revokes_only_this_workspaces_tokens_for_it_before_answering(
        self, harness: Harness, vendor: FakeVendor, session_factory
    ) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        ada = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, ada, "builder")
        github = await _granted(harness.session_factory, ada, agent_id, "github")
        atlassian = await _granted(harness.session_factory, ada, agent_id, "atlassian")
        await _make_tenant(session_factory, TENANT_A)
        async with harness.session_factory() as session:
            session.add_all(
                [
                    _issuance(github, ada.id, "github", "ghs_here"),
                    _issuance(atlassian, ada.id, "atlassian", "other_service"),
                ]
            )
            await session.commit()
        # Another workspace's token for the same service, which its own
        # revocation pass would leave alone just as this one must.
        async with tenant_session(session_factory, TENANT_A) as session:
            session.add(
                _issuance(None, ada.id, "github", "ghs_elsewhere", tenant_id=TENANT_A)
            )
            await session.commit()

        response = await _put(harness, admin, "github", {"enabled": False})

        assert response.json()["warning"] is None
        assert vendor.revoked == ["ghs_here"]
        here = await _issuances(session_factory, TENANT_ZERO_ID)
        assert here["ghs_here"].encrypted_token is None
        assert here["other_service"].revoke_requested is False
        elsewhere = await _issuances(session_factory, TENANT_A)
        assert elsewhere["ghs_elsewhere"].revoke_requested is False

    async def test_a_revoke_the_vendor_refuses_stays_queued_with_a_warning(
        self, harness: Harness, vendor: FakeVendor, session_factory
    ) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        ada = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, ada, "builder")
        github = await _granted(harness.session_factory, ada, agent_id, "github")
        async with harness.session_factory() as session:
            session.add(_issuance(github, ada.id, "github", "ghs_here"))
            await session.commit()

        async def unreachable(token: str) -> None:
            raise ServiceAdapterError("GitHub is unreachable.")

        vendor.revoke_issued = unreachable  # type: ignore[method-assign]
        response = await _put(harness, admin, "github", {"enabled": False})

        assert response.status_code == 200, response.text
        assert response.json()["warning"] == (
            "Some access already given out may remain for up to 1 hour."
        )
        record = (await _issuances(session_factory, TENANT_ZERO_ID))["ghs_here"]
        assert record.revoke_requested is True
        assert record.encrypted_token is not None

    async def test_keeps_the_grants(self, harness: Harness) -> None:
        admin = await _person(harness.session_factory, "admin", member_role="admin")
        ada = await add_member(harness.session_factory, "ada")
        await connect(harness.session_factory, ada.id)
        agent_id, _ = await agent_with_key(harness.session_factory, ada, "builder")
        grant = await grant_directly(harness.session_factory, agent_id, ada.id)

        await _put(harness, admin, "github", {"enabled": False})

        async with harness.session_factory() as session:
            kept = await session.scalar(
                select(ServiceGrant).where(ServiceGrant.id == grant.id)
            )
        assert kept is not None and kept.revision == grant.revision
