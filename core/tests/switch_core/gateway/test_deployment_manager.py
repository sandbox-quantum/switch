"""Who may manage the deployment's connector apps (`auth.deployment_manager`):
the platform operator, and the `org_admin`s of its only organization while it
has exactly one, asked again every time. `GET /auth/session` says so as
`can_manage_connector_apps`, and says as `connector_apps_in_dashboard`
whether they are set up in the dashboard at all, for whom to send someone
who may not.

The test database starts with one organization, the default workspace's
(`tests/conftest.py`)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Organization,
    OrganizationMember,
    TenantMember,
    User,
)
from switch_core.db.session_scope import organization_session
from switch_core.gateway.auth import create_jwt, deployment_manager
from tests.switch_core.gateway.test_tenant_resolution import (
    _KEYRING,
    _client,
    _session_app,
)


async def _person(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    organization_role: str | None,
    role: str = "user",
) -> User:
    """Someone in the default workspace, holding `organization_role` in its
    organization (None: no organization membership)."""
    name = f"person-{uuid.uuid4().hex[:6]}"
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.invalid", role=role)
        session.add(user)
        await session.flush()
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member")
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


async def _second_organization(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    organization_id = f"org-{uuid.uuid4().hex[:8]}"
    async with organization_session(session_factory, organization_id) as session:
        session.add(
            Organization(id=organization_id, slug=organization_id, name="Another")
        )
        await session.commit()


async def test_the_operator_may(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    operator = await _person(session_factory, organization_role=None, role="admin")
    await _second_organization(session_factory)

    manager = await deployment_manager(session_factory, operator)

    assert manager is not None and manager.organization_id is None
    assert manager.audit_details() == {}


async def test_the_only_organizations_admin_may(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _person(session_factory, organization_role="org_admin")

    manager = await deployment_manager(session_factory, admin)

    assert manager is not None and manager.organization_id == TENANT_ZERO_ID
    assert manager.audit_details() == {"as_admin_of_only_organization": TENANT_ZERO_ID}


async def test_an_org_admin_may_not_once_there_are_two_organizations(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _person(session_factory, organization_role="org_admin")
    assert await deployment_manager(session_factory, admin) is not None

    await _second_organization(session_factory)

    assert await deployment_manager(session_factory, admin) is None


async def test_a_member_of_the_only_organization_may_not(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    member = await _person(session_factory, organization_role="member")

    assert await deployment_manager(session_factory, member) is None


async def test_an_admin_demoted_loses_it_at_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _person(session_factory, organization_role="org_admin")
    async with organization_session(session_factory, TENANT_ZERO_ID) as session:
        member = await session.get(OrganizationMember, (TENANT_ZERO_ID, admin.id))
        assert member is not None
        member.role = "member"
        await session.commit()

    assert await deployment_manager(session_factory, admin) is None


async def _session_flag(
    session_factory: async_sessionmaker[AsyncSession],
    user: User,
    flag: str = "can_manage_connector_apps",
) -> bool:
    token = create_jwt(
        user.id,
        user.email,
        user.role,
        _KEYRING,
        TENANT_ZERO_ID,
        session_version=0,
        auth_time=datetime.now(UTC),
    )
    async with _client(_session_app(session_factory, signup_mode="open"), token) as c:
        response = await c.get("/auth/session")
    assert response.status_code == 200, response.text
    value = response.json()[flag]
    assert isinstance(value, bool)
    return value


async def test_the_session_says_so_and_stops_once_a_second_organization_exists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = await _person(session_factory, organization_role="org_admin")
    member = await _person(session_factory, organization_role="member")

    assert await _session_flag(session_factory, admin) is True
    assert await _session_flag(session_factory, member) is False

    await _second_organization(session_factory)

    assert await _session_flag(session_factory, admin) is False


async def test_the_session_says_where_they_are_set_up_to_everyone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """In the dashboard, by its organization's admins, while there is one
    organization; with the command once there are two. Members are told
    too: it is whom they ask."""
    flag = "connector_apps_in_dashboard"
    member = await _person(session_factory, organization_role="member")
    operator = await _person(session_factory, organization_role=None, role="admin")

    assert await _session_flag(session_factory, member, flag) is True
    assert await _session_flag(session_factory, operator, flag) is True

    await _second_organization(session_factory)

    assert await _session_flag(session_factory, member, flag) is False
    assert await _session_flag(session_factory, operator, flag) is False
    assert await _session_flag(session_factory, operator) is True
