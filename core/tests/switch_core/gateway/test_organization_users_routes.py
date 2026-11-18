"""The organization's people across its workspaces, against Postgres.

Its admins see which of its workspaces each person is in, and their role in
each, and add someone already in the organization to another of them. Only
an org admin adds; someone outside the organization is invited instead.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, OrganizationAuditAction
from switch_core.db.models import AuditEvent, OrganizationAuditEvent, User
from switch_core.db.session_scope import tenant_session
from tests.switch_core.gateway.test_organization_routes import _app, _client, _name
from tests.switch_core.gateway.test_workspace_archive_routes import (
    WORKSPACES,
    _organization,
    _with_archive,
)

pytestmark = pytest.mark.asyncio

MEMBERS = "/organizations/current/members"


def _workspaces(listed: list[dict], user_id: str) -> list[tuple[str, str, bool]]:
    [row] = [row for row in listed if row["user_id"] == user_id]
    return [(w["id"], w["role"], w["archived"]) for w in row["workspaces"]]


async def test_each_person_comes_with_the_workspaces_they_are_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    app = _app(session_factory)
    _with_archive(app)
    org = await _organization(session_factory, app)
    async with _client(app, org.ada, org.first) as client:
        before = await client.get(MEMBERS)
        await client.post(f"{WORKSPACES}/{org.second}/archive")
        after = await client.get(MEMBERS)

    assert before.status_code == 200, before.text
    listed = before.json()
    # She made the second, which made her its admin too; in name order.
    assert _workspaces(listed, org.ada) == [
        (org.first, "admin", False),
        (org.second, "admin", False),
    ]
    assert _workspaces(listed, org.bob) == [(org.second, "member", False)]
    assert _workspaces(listed, org.carol) == [(org.second, "admin", False)]
    assert _workspaces(after.json(), org.bob) == [(org.second, "member", True)]


async def test_an_org_admin_adds_someone_in_the_organization_to_another_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    app = _app(session_factory)
    _with_archive(app)
    org = await _organization(session_factory, app)

    async with _client(app, org.ada, org.first) as client:
        added = await client.post(
            f"{WORKSPACES}/{org.first}/members",
            json={"user_id": org.bob, "role": "member"},
        )
        again = await client.post(
            f"{WORKSPACES}/{org.first}/members",
            json={"user_id": org.bob, "role": "admin"},
        )
        listed = await client.get(MEMBERS)

    assert added.status_code == 201, added.text
    assert added.json() == {
        "id": org.first,
        "name": "Acme",
        "role": "member",
        "archived": False,
    }
    assert again.status_code == 409
    assert set(_workspaces(listed.json(), org.bob)) == {
        (org.first, "member", False),
        (org.second, "member", False),
    }
    async with tenant_session(session_factory, org.first) as session:
        [workspace_event] = list(
            await session.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.MEMBER_ADDED_BY_ORGANIZATION
                )
            )
        )
        [organization_event] = list(
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.action
                    == OrganizationAuditAction.MEMBER_ADDED_TO_WORKSPACE
                )
            )
        )
    assert (workspace_event.target_id, workspace_event.details) == (
        org.bob,
        {"role": "member"},
    )
    assert organization_event.details == {
        "workspace": org.first,
        "workspace_name": "Acme",
        "role": "member",
        "workspace_id": org.first,
    }


async def test_someone_outside_the_organization_is_invited_instead(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    app = _app(session_factory)
    _with_archive(app)
    org = await _organization(session_factory, app)
    stranger = _name("stranger")
    async with session_factory() as session:
        session.add(
            User(
                id=stranger,
                name=stranger,
                email=f"{stranger}@example.invalid",
                role="user",
            )
        )
        await session.commit()

    async with _client(app, org.ada, org.first) as client:
        response = await client.post(
            f"{WORKSPACES}/{org.first}/members",
            json={"user_id": stranger, "role": "member"},
        )

    assert response.status_code == 404
    assert "invite them" in response.json()["detail"]


async def test_nobody_is_added_to_an_archived_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    app = _app(session_factory)
    _with_archive(app)
    org = await _organization(session_factory, app)
    async with _client(app, org.ada, org.first) as client:
        await client.post(f"{WORKSPACES}/{org.second}/archive")
        response = await client.post(
            f"{WORKSPACES}/{org.second}/members",
            json={"user_id": org.ada, "role": "member"},
        )

    assert response.status_code == 409
    assert "archived" in response.json()["detail"]


async def test_a_workspace_admin_who_is_no_org_admin_adds_nobody(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    app = _app(session_factory)
    _with_archive(app)
    org = await _organization(session_factory, app)

    async with _client(app, org.carol, org.second) as client:
        response = await client.post(
            f"{WORKSPACES}/{org.first}/members",
            json={"user_id": org.bob, "role": "member"},
        )

    assert response.status_code == 403
