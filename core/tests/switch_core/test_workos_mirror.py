"""The WorkOS mirror: events and the daily check applied to linked
organizations, against Postgres on the restricted role and a stand-in for
WorkOS; `owner` only arranges fixtures and reads results."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    DirectoryEventCursor,
    OidcIdentity,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    User,
)
from switch_core.organization_directory import DirectoryUnavailable
from switch_core.workos_mirror import EVENT_TYPES, WorkOSMirror
from tests.conftest import RLSHarness
from tests.switch_core.test_organization_mirror_apply import _revocation

pytestmark = pytest.mark.no_ambient_tenant

ISSUER = "https://auth.example.test"


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


class _WorkOS:
    """Memberships by (WorkOS user, WorkOS organization) -> Switch role, and
    the events that changed them, served a page of `page` at a time."""

    def __init__(self, page: int = 100) -> None:
        self.memberships: dict[tuple[str, str], str] = {}
        self.log: list[dict[str, Any]] = []
        self.page = page
        self.asked: list[dict[str, Any]] = []
        self.fail_role_for: str | None = None

    def change(self, subject: str, organization: str, role: str | None) -> None:
        if role is None:
            self.memberships.pop((subject, organization), None)
            kind = "deleted"
        else:
            kind = (
                "created"
                if (subject, organization) not in self.memberships
                else "updated"
            )
            self.memberships[(subject, organization)] = role
        self.log.append(
            {
                "id": f"event_{len(self.log):04d}",
                "event": f"organization_membership.{kind}",
                "data": {"user_id": subject, "organization_id": organization},
            }
        )

    async def events(
        self, types: tuple[str, ...], *, after: str | None, range_start: str
    ) -> list[dict[str, Any]]:
        assert types == EVENT_TYPES
        self.asked.append({"after": after, "range_start": range_start})
        start = 0
        if after is not None:
            start = next(i for i, e in enumerate(self.log) if e["id"] == after) + 1
        return self.log[start : start + self.page]

    async def membership_role(self, subject: str, organization: str) -> str | None:
        if subject == self.fail_role_for:
            raise DirectoryUnavailable("WorkOS answered 500.")
        return self.memberships.get((subject, organization))

    async def organization_members(self, organization: str) -> dict[str, str]:
        return {
            subject: role
            for (subject, org), role in self.memberships.items()
            if org == organization
        }


async def _linked(owner) -> tuple[str, str]:
    organization_id, workos_id = _id("org"), _id("org_workos")
    async with owner() as session:
        session.add(
            Organization(
                id=organization_id,
                slug=organization_id,
                name="Acme",
                workos_organization_id=workos_id,
            )
        )
        await session.commit()
    return organization_id, workos_id


async def _person(owner, subject: str | None) -> str:
    user_id = _id("user")
    async with owner() as session:
        session.add(
            User(
                id=user_id,
                name=user_id,
                email=f"{user_id}@example.invalid",
                role="user",
            )
        )
        await session.flush()
        if subject is not None:
            session.add(OidcIdentity(user_id=user_id, iss=ISSUER, sub=subject))
        await session.commit()
    return user_id


async def _member(owner, organization_id: str, user_id: str, role: str) -> None:
    async with owner() as session:
        session.add(
            OrganizationMember(
                organization_id=organization_id, user_id=user_id, role=role
            )
        )
        await session.commit()


async def _roles(owner, organization_id: str) -> dict[str, str]:
    async with owner() as session:
        rows = await session.execute(
            select(OrganizationMember.user_id, OrganizationMember.role).where(
                OrganizationMember.organization_id == organization_id
            )
        )
        return {user_id: role for user_id, role in rows}


def _mirror(rls_harness: RLSHarness, workos: _WorkOS) -> WorkOSMirror:
    return WorkOSMirror(
        rls_harness.restricted,
        workos,  # type: ignore[arg-type]
        _revocation(rls_harness.restricted),
        ISSUER,
    )


class TestEvents:
    async def test_the_first_poll_starts_from_now_and_later_ones_from_the_cursor(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        ada = await _person(owner, "user_ADA")
        workos = _WorkOS(page=1)
        mirror = _mirror(rls_harness, workos)

        assert await mirror.poll_once() == 0
        workos.change("user_ADA", workos_id, "member")
        workos.change("user_ADA", workos_id, "org_admin")
        assert await mirror.poll_once() == 2

        assert await _roles(owner, organization_id) == {ada: "org_admin"}
        assert workos.asked[0]["after"] is None
        assert workos.asked[-1]["after"] == "event_0001"
        async with owner() as session:
            cursor = await session.get(DirectoryEventCursor, "workos")
        assert cursor is not None and cursor.after == "event_0001"
        assert await mirror.poll_once() == 0

    async def test_an_event_reads_the_membership_as_it_is_now(
        self, rls_harness: RLSHarness
    ) -> None:
        """Read after the membership has gone, a `created` event removes
        nothing and adds nothing."""
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        await _person(owner, "user_ADA")
        workos = _WorkOS()
        mirror = _mirror(rls_harness, workos)
        await mirror.poll_once()
        workos.change("user_ADA", workos_id, "member")
        workos.change("user_ADA", workos_id, None)

        await mirror.poll_once()

        assert await _roles(owner, organization_id) == {}

    async def test_a_removal_is_applied(self, rls_harness: RLSHarness) -> None:
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        ada = await _person(owner, "user_ADA")
        bea = await _person(owner, "user_BEA")
        await _member(owner, organization_id, ada, "member")
        await _member(owner, organization_id, bea, "org_admin")
        workos = _WorkOS()
        workos.memberships[("user_ADA", workos_id)] = "member"
        mirror = _mirror(rls_harness, workos)
        await mirror.poll_once()
        workos.change("user_ADA", workos_id, None)

        await mirror.poll_once()

        assert await _roles(owner, organization_id) == {bea: "org_admin"}

    async def test_events_for_other_organizations_and_strangers_are_skipped(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        await _person(owner, "user_ADA")
        workos = _WorkOS()
        mirror = _mirror(rls_harness, workos)
        await mirror.poll_once()
        workos.change("user_ADA", _id("org_elsewhere"), "org_admin")
        workos.change("user_NOBODY", workos_id, "org_admin")

        assert await mirror.poll_once() == 2

        assert await _roles(owner, organization_id) == {}

    async def test_an_event_that_fails_is_read_again_next_time(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        ada = await _person(owner, "user_ADA")
        workos = _WorkOS()
        mirror = _mirror(rls_harness, workos)
        await mirror.poll_once()
        workos.change("user_ADA", workos_id, "member")
        workos.fail_role_for = "user_ADA"

        with pytest.raises(DirectoryUnavailable):
            await mirror.poll_once()
        workos.fail_role_for = None
        assert await mirror.poll_once() == 1

        assert await _roles(owner, organization_id) == {ada: "member"}

    async def test_a_deleted_organization_removes_nobody_and_is_reported(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        ada = await _person(owner, "user_ADA")
        await _member(owner, organization_id, ada, "org_admin")
        workos = _WorkOS()
        mirror = _mirror(rls_harness, workos)
        await mirror.poll_once()
        workos.log.append(
            {
                "id": "event_9999",
                "event": "organization.deleted",
                "data": {"id": workos_id},
            }
        )

        await mirror.poll_once()

        assert await _roles(owner, organization_id) == {ada: "org_admin"}
        async with owner() as session:
            [event] = await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == organization_id
                )
            )
        assert event.action == OrganizationAuditAction.DIRECTORY_CONFLICT
        assert event.details["kind"] == "directory_organization_deleted"


class TestDailyCheck:
    async def test_brings_every_linked_organization_in_line(
        self, rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
    ) -> None:
        owner = rls_harness.owner
        organization_id, workos_id = await _linked(owner)
        ada = await _person(owner, "user_ADA")  # listed, not in Switch
        bea = await _person(owner, "user_BEA")  # in Switch, no longer listed
        cy = await _person(owner, "user_CY")  # org_admin in Switch, member there
        dee = await _person(owner, None)  # in Switch, no WorkOS identity
        eve = await _person(owner, "user_EVE")  # stays org_admin
        for user_id, role in (
            (bea, "member"),
            (cy, "org_admin"),
            (dee, "member"),
            (eve, "org_admin"),
        ):
            await _member(owner, organization_id, user_id, role)
        workos = _WorkOS()
        workos.memberships = {
            ("user_ADA", workos_id): "member",
            ("user_CY", workos_id): "member",
            ("user_EVE", workos_id): "org_admin",
            ("user_STRANGER", workos_id): "member",
        }

        await _mirror(rls_harness, workos).check_once()

        assert await _roles(owner, organization_id) == {
            ada: "member",
            cy: "member",
            dee: "member",
            eve: "org_admin",
        }
        assert f"User {dee} is in organization" in caplog.text
