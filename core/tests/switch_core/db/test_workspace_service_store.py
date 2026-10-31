"""A workspace admin's switch per service, against Postgres.

No row means the workspace's default, off for a workspace made since services
started off. The isolation test writes through the restricted role the
server connects as, so a missing policy fails it rather than being bypassed
by the superuser's exemption.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Tenant, User, WorkspaceServiceSetting
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_service_store import OrganizationServiceStore
from switch_core.db.stores.workspace_service_store import (
    ServiceSwitch,
    WorkspaceServiceStore,
)
from tests.conftest import RLSHarness

STORE = WorkspaceServiceStore()
SERVICES = ["atlassian", "datadog", "github"]


async def _user(session_factory: async_sessionmaker[AsyncSession], name: str) -> str:
    async with session_factory() as session:
        user = User(
            name=name,
            email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid",
            role="user",
        )
        session.add(user)
        await session.commit()
        return user.id


async def _on_by_default(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == TENANT_ZERO_ID)
            .values(services_on_by_default=True)
        )
        await session.commit()


class TestSwitch:
    async def test_a_new_workspace_with_no_row_has_every_service_off(
        self, session_factory
    ) -> None:
        async with session_factory() as session:
            assert await STORE.on_by_default(session) is False
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is False
            )
            assert await STORE.disabled_services(
                session, SERVICES, organizations=False
            ) == set(SERVICES)
            assert await STORE.list_settings(session) == {}

    async def test_a_workspace_on_by_default_with_no_row_has_every_service_on(
        self, session_factory
    ) -> None:
        await _on_by_default(session_factory)
        async with session_factory() as session:
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is True
            )
            assert (
                await STORE.disabled_services(session, SERVICES, organizations=False)
                == set()
            )

    async def test_on_then_off_round_trips_in_a_new_workspace(
        self, session_factory
    ) -> None:
        admin = await _user(session_factory, "admin")
        async with session_factory() as session:
            await STORE.set_enabled(session, "datadog", True, admin)
            await session.commit()
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is True
            )
            assert (
                await STORE.is_enabled(session, "atlassian", organizations=False)
                is False
            )
            assert await STORE.disabled_services(
                session, SERVICES, organizations=False
            ) == {
                "atlassian",
                "github",
            }

            await STORE.set_enabled(session, "datadog", False, admin)
            await session.commit()
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is False
            )
            assert await STORE.disabled_services(
                session, SERVICES, organizations=False
            ) == set(SERVICES)

    async def test_off_then_on_round_trips_in_a_workspace_on_by_default(
        self, session_factory
    ) -> None:
        await _on_by_default(session_factory)
        admin = await _user(session_factory, "admin")
        async with session_factory() as session:
            await STORE.set_enabled(session, "datadog", False, admin)
            await session.commit()
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is False
            )
            assert (
                await STORE.is_enabled(session, "atlassian", organizations=False)
                is True
            )
            assert await STORE.disabled_services(
                session, SERVICES, organizations=False
            ) == {"datadog"}

            await STORE.set_enabled(session, "datadog", True, admin)
            await session.commit()
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is True
            )
            assert (
                await STORE.disabled_services(session, SERVICES, organizations=False)
                == set()
            )

    async def test_the_same_switch_twice_is_one_row_naming_the_last_admin(
        self, session_factory
    ) -> None:
        first = await _user(session_factory, "first")
        second = await _user(session_factory, "second")
        async with session_factory() as session:
            await STORE.set_enabled(session, "github", False, first)
            await session.commit()
            before = (await STORE.list_settings(session))["github"].updated_at
            await STORE.set_enabled(session, "github", False, second)
            await session.commit()
            rows = list(await session.scalars(select(WorkspaceServiceSetting)))
        assert [(row.service, row.enabled, row.updated_by) for row in rows] == [
            ("github", False, second)
        ]
        assert rows[0].updated_at >= before


@pytest.mark.no_ambient_tenant
class TestIsolation:
    async def test_a_row_written_in_one_workspace_is_invisible_from_another(
        self, rls_harness: RLSHarness
    ) -> None:
        mine = f"tenant-{uuid.uuid4().hex[:8]}"
        theirs = f"tenant-{uuid.uuid4().hex[:8]}"
        async with rls_harness.owner() as session:
            for tenant_id in (mine, theirs):
                session.add(
                    Tenant(
                        id=tenant_id,
                        slug=tenant_id,
                        name=tenant_id,
                        services_on_by_default=True,
                    )
                )
            await session.commit()
        admin = await _user(rls_harness.owner, "admin")

        async with tenant_session(rls_harness.restricted, mine) as session:
            await STORE.set_enabled(session, "datadog", False, admin)
            await session.commit()

        async with tenant_session(rls_harness.restricted, theirs) as session:
            # Unfiltered, so only the policy stands between this read and the row.
            raw = await session.execute(
                text("SELECT service FROM workspace_service_settings")
            )
            assert raw.all() == []
            assert (
                await STORE.is_enabled(session, "datadog", organizations=False) is True
            )
            assert (
                await STORE.disabled_services(session, SERVICES, organizations=False)
                == set()
            )

        async with tenant_session(rls_harness.restricted, mine) as session:
            assert await STORE.disabled_services(
                session, SERVICES, organizations=False
            ) == {"datadog"}


class TestTheOrganizationsSay:
    """The first of: the organization's setting, if locked; the workspace's
    own; the organization's, unlocked; the workspace's default."""

    async def _organization(self, session_factory, *, enabled: bool, locked: bool):
        admin = await _user(session_factory, "org-admin")
        async with session_factory() as session:
            await OrganizationServiceStore().set(
                session,
                TENANT_ZERO_ID,
                "datadog",
                enabled=enabled,
                locked=locked,
                updated_by=admin,
            )
            await session.commit()

    async def _own(self, session_factory, enabled: bool) -> None:
        admin = await _user(session_factory, "workspace-admin")
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await STORE.set_enabled(session, "datadog", enabled, admin)
            await session.commit()

    async def _switch(self, session_factory, *, organizations: bool) -> ServiceSwitch:
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            return (
                await STORE.switches(session, ["datadog"], organizations=organizations)
            )["datadog"]

    async def test_locked_wins_over_the_workspaces_own(self, session_factory) -> None:
        await self._own(session_factory, True)
        await self._organization(session_factory, enabled=False, locked=True)
        assert await self._switch(session_factory, organizations=True) == ServiceSwitch(
            enabled=False, locked=True
        )

    async def test_the_workspaces_own_wins_over_unlocked(self, session_factory) -> None:
        await self._own(session_factory, False)
        await self._organization(session_factory, enabled=True, locked=False)
        assert await self._switch(session_factory, organizations=True) == ServiceSwitch(
            enabled=False, locked=False
        )

    async def test_unlocked_wins_over_the_workspaces_default(
        self, session_factory
    ) -> None:
        await self._organization(session_factory, enabled=True, locked=False)
        assert await self._switch(session_factory, organizations=True) == ServiceSwitch(
            enabled=True, locked=False
        )

    async def test_without_organizations_their_settings_are_not_read(
        self, session_factory
    ) -> None:
        await self._organization(session_factory, enabled=True, locked=True)
        assert await self._switch(
            session_factory, organizations=False
        ) == ServiceSwitch(enabled=False, locked=False)
