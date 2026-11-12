"""Archiving and restoring an organization's workspace, against Postgres.

Only the organization's admins archive or restore, never the workspace their
request is bound to or the one everyone signing up joins. An archived
workspace is closed to its members, who are told why, while the
organization's admins still enter it and see it listed; it can't be joined.
Both changes are in both audit logs, and what they shut or open again
(`workspace_archive.py`) is asked for once each has committed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, OrganizationAuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    OrganizationAuditEvent,
    OrganizationMember,
    Room,
    RoomSchedule,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import (
    list_held_memberships,
    list_tenant_memberships,
    session_still_enters,
)
from tests.switch_core.gateway.test_organization_routes import (
    _app,
    _client,
    _name,
    _operator,
    _workspace,
)

pytestmark = pytest.mark.asyncio

WORKSPACES = "/organizations/current/workspaces"


class _Archive:
    """What the routes ask to shut or open, recorded."""

    def __init__(self) -> None:
        self.closed: list[str] = []
        self.reopened: list[str] = []

    async def closed_(self, tenant_id: str) -> None:
        self.closed.append(tenant_id)

    async def reopened_(self, tenant_id: str) -> None:
        self.reopened.append(tenant_id)


def _with_archive(app: FastAPI) -> _Archive:
    app.dependency_overrides[gw_deps.get_invitation_store] = lambda: InvitationStore()
    app.dependency_overrides[gw_deps.get_invite_mailer] = lambda: None
    archive = _Archive()
    app.state.workspace_archive = type(
        "Recording",
        (),
        {
            "closed": staticmethod(archive.closed_),
            "reopened": staticmethod(archive.reopened_),
        },
    )()
    return archive


class _Organization:
    """An organization with two workspaces: `first`, which `ada` (its
    org_admin) works in, and `second`, where `bob` is a plain member and
    `carol` its admin by membership."""

    def __init__(self, first: str, second: str, ada: str, bob: str, carol: str) -> None:
        self.first, self.second = first, second
        self.ada, self.bob, self.carol = ada, bob, carol


async def _organization(
    session_factory: async_sessionmaker[AsyncSession], app: FastAPI
) -> _Organization:
    ada, bob, carol = _name("ada"), _name("bob"), _name("carol")
    first = await _workspace(session_factory, {ada: ("admin", "org_admin")})
    async with _client(app, ada, first) as client:
        created = await client.post(WORKSPACES, json={"name": "Second"})
        assert created.status_code == 201, created.text
    second = created.json()["id"]
    async with tenant_session(session_factory, second) as session:
        tenant = await session.get(Tenant, second)
        assert tenant is not None
        for name, role in ((bob, "member"), (carol, "admin")):
            session.add(
                User(id=name, name=name, email=f"{name}@example.invalid", role="user")
            )
            await session.flush()
            session.add(TenantMember(tenant_id=second, user_id=name, role=role))
            session.add(
                OrganizationMember(
                    organization_id=tenant.organization_id, user_id=name, role="member"
                )
            )
        await session.commit()
    return _Organization(first, second, ada, bob, carol)


async def _archived_at(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> tuple[Any, Any]:
    async with tenant_session(session_factory, tenant_id) as session:
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None
        return tenant.archived_at, tenant.archived_by


async def _audit(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> tuple[list[str], list[tuple[str, dict]]]:
    async with tenant_session(session_factory, tenant_id) as session:
        workspace = [
            event.action
            for event in await session.scalars(
                select(AuditEvent)
                .where(AuditEvent.action.in_(("tenant.archived", "tenant.restored")))
                .order_by(AuditEvent.occurred_at)
            )
        ]
        organization = [
            (event.action, event.details)
            for event in await session.scalars(
                select(OrganizationAuditEvent)
                .where(OrganizationAuditEvent.target_id == tenant_id)
                .where(
                    OrganizationAuditEvent.action.in_(
                        (
                            OrganizationAuditAction.WORKSPACE_ARCHIVED,
                            OrganizationAuditAction.WORKSPACE_RESTORED,
                        )
                    )
                )
                .order_by(OrganizationAuditEvent.occurred_at)
            )
        ]
    return workspace, organization


class TestArchiving:
    async def test_an_org_admin_archives_another_workspace_and_it_is_audited(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        archive = _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            response = await client.post(f"{WORKSPACES}/{org.second}/archive")
            listed = await client.get(WORKSPACES)

        assert response.status_code == 200, response.text
        assert response.json()["archived_at"] is not None
        archived_at, archived_by = await _archived_at(session_factory, org.second)
        assert archived_at is not None and archived_by == org.ada
        assert archive.closed == [org.second]
        workspace_log, organization_log = await _audit(session_factory, org.second)
        assert workspace_log == [AuditAction.TENANT_ARCHIVED]
        assert organization_log == [
            (
                OrganizationAuditAction.WORKSPACE_ARCHIVED,
                {"name": "Second", "workspace_id": org.first},
            )
        ]
        rows = {row["id"]: row for row in listed.json()}
        assert rows[org.second]["archived_at"] is not None
        assert rows[org.second]["can_restore"] is True
        assert rows[org.second]["can_archive"] is False
        assert rows[org.first]["can_archive"] is False
        assert rows[org.first]["archive_blocked_reason"] == (
            "You're working in this workspace. Switch to another one first."
        )

    async def test_archiving_again_records_nothing_more_but_shuts_it_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """So a call that failed part way through is finished by repeating it."""
        app = _app(session_factory)
        archive = _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            for _ in range(2):
                response = await client.post(f"{WORKSPACES}/{org.second}/archive")
                assert response.status_code == 200, response.text

        workspace_log, organization_log = await _audit(session_factory, org.second)
        assert (len(workspace_log), len(organization_log)) == (1, 1)
        assert archive.closed == [org.second, org.second]

    async def test_the_workspace_the_request_is_bound_to_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        archive = _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            response = await client.post(f"{WORKSPACES}/{org.first}/archive")

        assert response.status_code == 409
        assert "Switch to another one first" in response.json()["detail"]
        assert (await _archived_at(session_factory, org.first))[0] is None
        assert archive.closed == []

    async def test_the_workspace_everyone_joins_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        ada = _name("ada")
        async with session_factory() as session:
            session.add(
                User(id=ada, name=ada, email=f"{ada}@example.invalid", role="user")
            )
            await session.flush()
            session.add(
                TenantMember(tenant_id=TENANT_ZERO_ID, user_id=ada, role="admin")
            )
            session.add(
                OrganizationMember(
                    organization_id=TENANT_ZERO_ID, user_id=ada, role="org_admin"
                )
            )
            await session.commit()
        async with _client(app, ada, TENANT_ZERO_ID) as client:
            created = await client.post(WORKSPACES, json={"name": "Elsewhere"})
            assert created.status_code == 201, created.text
        elsewhere = created.json()["id"]

        async with _client(app, ada, elsewhere) as client:
            response = await client.post(f"{WORKSPACES}/{TENANT_ZERO_ID}/archive")

        assert response.status_code == 409
        assert "Everyone who signs up joins this workspace" in response.json()["detail"]

    async def test_a_workspace_admin_who_is_no_org_admin_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        archive = _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.carol, org.second) as client:
            response = await client.post(f"{WORKSPACES}/{org.first}/archive")
            listed = await client.get(WORKSPACES)

        assert response.status_code == 403
        assert archive.closed == []
        [row] = listed.json()
        assert row["can_archive"] is False
        assert row["archive_blocked_reason"] == (
            "Only an organization admin can archive a workspace."
        )

    async def test_a_workspace_of_another_organization_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        other = await _workspace(
            session_factory, {_name("zed"): ("admin", "org_admin")}
        )

        async with _client(app, org.ada, org.first) as client:
            response = await client.post(f"{WORKSPACES}/{other}/archive")

        assert response.status_code == 404
        assert (await _archived_at(session_factory, other))[0] is None


class TestAnArchivedWorkspace:
    async def test_its_members_no_longer_have_it_and_are_told_why(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.first) as client:
            archived = await client.post(f"{WORKSPACES}/{org.second}/archive")
            assert archived.status_code == 200, archived.text

        async with _client(app, org.bob, org.second) as client:
            refused = await client.get("/tenants/current")
        async with _client(app, org.bob, None) as client:
            unclaimed = await client.get("/tenants/current")
            listed = await client.get("/tenants")

        for response in (refused, unclaimed):
            assert response.status_code == 403
            assert response.json()["detail"]["error"] == "tenant_archived"
        assert listed.status_code == 200
        assert listed.json() == []

    async def test_a_member_switching_to_it_is_told_it_is_archived(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")

        async with _client(app, org.bob, None) as client:
            switched = await client.post(f"/tenants/{org.second}/switch")

        assert switched.status_code == 403
        assert "archived" in switched.json()["detail"]

    async def test_the_operator_sees_it_archived_among_every_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")
        operator = await _operator(session_factory)

        async with _client(app, operator, None) as client:
            listed = await client.get("/operator/workspaces")

        assert listed.status_code == 200, listed.text
        archived = {row["id"]: row["archived_at"] for row in listed.json()}
        assert archived[org.second] is not None
        assert archived[org.first] is None

    async def test_its_organizations_admin_still_enters_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")

        async with _client(app, org.ada, org.second) as client:
            current = await client.get("/tenants/current")
            listed = await client.get("/tenants")

        assert current.status_code == 200, current.text
        assert current.json()["archived_at"] is not None
        assert org.second in {row["id"] for row in listed.json()}

    async def test_an_invitation_to_it_is_not_accepted_and_none_is_made(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.second) as client:
            invited = await client.post(
                f"/tenants/{org.second}/invitations", json={"role": "member"}
            )
            assert invited.status_code == 201, invited.text
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")
        newcomer = _name("newcomer")
        async with session_factory() as session:
            session.add(
                User(
                    id=newcomer,
                    name=newcomer,
                    email=f"{newcomer}@example.invalid",
                    role="user",
                )
            )
            await session.commit()

        async with _client(app, newcomer, None) as client:
            accepted = await client.post(
                "/invitations/accept", json={"token": invited.json()["token"]}
            )
        async with _client(app, org.ada, org.second) as client:
            made = await client.post(
                f"/tenants/{org.second}/invitations", json={"role": "member"}
            )

        assert accepted.status_code == 409
        assert "archived" in accepted.json()["detail"]
        assert made.status_code == 409

    async def test_deleting_an_account_still_finds_the_membership_in_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What a person holds is not where they may go: their membership in
        an archived workspace is still theirs to account for."""
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")

        enterable = await list_tenant_memberships(session_factory, UserStore(), org.bob)
        held = await list_held_memberships(session_factory, UserStore(), org.bob)

        assert enterable == []
        assert [(row.id, row.role) for row in held] == [(org.second, "member")]
        assert held[0].archived_at is not None

    async def test_a_members_open_stream_stops_being_current(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A socket or stream opened before the workspace was archived asks
        again at each re-check, and is closed; its org admin's is not."""
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async def current(user_id: str) -> bool:
            return await session_still_enters(
                session_factory, UserStore(), user_id, 0, org.second
            )

        before = await current(org.bob)
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")

        assert before is True
        assert await current(org.bob) is False
        assert await current(org.ada) is True


class TestRestoring:
    async def test_restoring_opens_it_to_its_members_again_and_is_audited(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        archive = _with_archive(app)
        org = await _organization(session_factory, app)
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")
            restored = await client.post(f"{WORKSPACES}/{org.second}/restore")

        async with _client(app, org.bob, org.second) as client:
            current = await client.get("/tenants/current")

        assert restored.status_code == 200, restored.text
        assert restored.json()["archived_at"] is None
        assert await _archived_at(session_factory, org.second) == (None, None)
        assert archive.reopened == [org.second]
        assert current.status_code == 200, current.text
        workspace_log, organization_log = await _audit(session_factory, org.second)
        assert workspace_log == [
            AuditAction.TENANT_ARCHIVED,
            AuditAction.TENANT_RESTORED,
        ]
        assert [action for action, _ in organization_log] == [
            OrganizationAuditAction.WORKSPACE_ARCHIVED,
            OrganizationAuditAction.WORKSPACE_RESTORED,
        ]

    async def test_runs_missed_while_archived_are_skipped_as_it_is_restored(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """In the commit that opens it, so the scheduler never sees it open
        with them still due."""
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        missed = datetime.now(UTC) - timedelta(days=2)
        async with tenant_session(session_factory, org.second) as session:
            room = Room(transport_room_id="!standup", name="standup", description="")
            session.add(room)
            await session.flush()
            schedule = RoomSchedule(
                room_id=room.id,
                author_id=org.carol,
                agent_ids=[],
                text="Summarise the new issues.",
                cron="0 9 * * *",
                run_at=None,
                timezone="Europe/London",
                paused=False,
                next_run_at=missed,
            )
            session.add(schedule)
            await session.commit()
            schedule_id = schedule.id
        async with _client(app, org.ada, org.first) as client:
            await client.post(f"{WORKSPACES}/{org.second}/archive")
            restoring = datetime.now(UTC)
            await client.post(f"{WORKSPACES}/{org.second}/restore")

        async with tenant_session(session_factory, org.second) as session:
            moved = await session.get(RoomSchedule, schedule_id)
        assert moved is not None and moved.next_run_at is not None
        assert moved.next_run_at > restoring
        assert moved.last_run_at is None

    async def test_only_an_org_admin_restores(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        archive = _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.carol, org.second) as client:
            response = await client.post(f"{WORKSPACES}/{org.second}/restore")

        assert response.status_code == 403
        assert archive.reopened == []
