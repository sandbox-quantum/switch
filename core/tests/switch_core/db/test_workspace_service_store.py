"""A workspace admin's switch per service, against Postgres.

No row means on. The isolation test writes through the restricted role the
server connects as, so a missing policy fails it rather than being bypassed
by the superuser's exemption.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Tenant, User, WorkspaceServiceSetting
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from tests.conftest import RLSHarness

STORE = WorkspaceServiceStore()


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


class TestSwitch:
    async def test_with_no_row_every_service_is_on(self, session_factory) -> None:
        async with session_factory() as session:
            assert await STORE.is_enabled(session, "datadog") is True
            assert await STORE.disabled_services(session) == set()
            assert await STORE.list_settings(session) == {}

    async def test_off_then_on_round_trips(self, session_factory) -> None:
        admin = await _user(session_factory, "admin")
        async with session_factory() as session:
            await STORE.set_enabled(session, "datadog", False, admin)
            await session.commit()
            assert await STORE.is_enabled(session, "datadog") is False
            assert await STORE.is_enabled(session, "atlassian") is True
            assert await STORE.disabled_services(session) == {"datadog"}

            await STORE.set_enabled(session, "datadog", True, admin)
            await session.commit()
            assert await STORE.is_enabled(session, "datadog") is True
            assert await STORE.disabled_services(session) == set()

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
                session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
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
            assert await STORE.is_enabled(session, "datadog") is True
            assert await STORE.disabled_services(session) == set()

        async with tenant_session(rls_harness.restricted, mine) as session:
            assert await STORE.disabled_services(session) == {"datadog"}
