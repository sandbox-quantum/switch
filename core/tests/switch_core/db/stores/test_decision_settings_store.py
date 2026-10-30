"""A workspace's decision backend row, on real Postgres: one per workspace,
replaced in place, cleared back to the server default, and invisible to
every other workspace under row-level security."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, DecisionSettings, Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from tests.conftest import RLSHarness
from tests.switch_core.decision.machine_helpers import MODEL, add_controller

STORE = DecisionSettingsStore()
TENANT_B = "decision-store-tenant-b"


async def _tenant(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()


async def test_two_workspaces_rows_stay_separate(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _tenant(session_factory, TENANT_B)
    async with session_factory() as session:
        await STORE.save(
            session,
            TENANT_ZERO_ID,
            backend="endpoint",
            endpoint="http://a.test/decide",
            api_key_encrypted="enc-a",
            threshold=0.6,
        )
        await STORE.save(
            session,
            TENANT_B,
            backend="none",
            endpoint=None,
            api_key_encrypted=None,
            threshold=None,
        )
        await session.commit()

    async with session_factory() as session:
        a = await STORE.get(session, TENANT_ZERO_ID)
        b = await STORE.get(session, TENANT_B)
        assert a is not None and b is not None
        assert (a.backend, a.endpoint, a.api_key_encrypted, a.threshold) == (
            "endpoint",
            "http://a.test/decide",
            "enc-a",
            0.6,
        )
        assert (b.backend, b.endpoint, b.api_key_encrypted) == ("none", None, None)

        await STORE.clear(session, TENANT_B)
        await session.commit()
        assert await STORE.get(session, TENANT_B) is None
        assert await STORE.get(session, TENANT_ZERO_ID) is not None


async def test_a_save_replaces_the_row_in_place(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        first = await STORE.save(
            session,
            TENANT_ZERO_ID,
            backend="haiku_anthropic",
            endpoint=None,
            api_key_encrypted="enc-1",
            threshold=None,
        )
        stamped = first.updated_at
        await session.commit()
        second = await STORE.save(
            session,
            TENANT_ZERO_ID,
            backend="endpoint",
            endpoint="http://b.test/decide",
            api_key_encrypted=None,
            threshold=0.9,
        )
        await session.commit()
        rows = (await session.scalars(select(DecisionSettings))).all()

    assert len(rows) == 1
    assert second.backend == "endpoint" and second.api_key_encrypted is None
    assert second.updated_at >= stamped


@pytest.mark.parametrize(
    ("backend", "threshold"), [("somewhere", None), ("none", 1.5), ("none", -0.1)]
)
async def test_the_database_refuses_what_the_routes_refuse(
    session_factory: async_sessionmaker[AsyncSession],
    backend: str,
    threshold: float | None,
) -> None:
    async with session_factory() as session:
        with pytest.raises(IntegrityError):
            await STORE.save(
                session,
                TENANT_ZERO_ID,
                backend=backend,
                endpoint=None,
                api_key_encrypted=None,
                threshold=threshold,
            )


async def test_a_workspace_cannot_read_anothers_row_under_row_level_security(
    rls_harness: RLSHarness,
) -> None:
    tenant_a = f"decision-rls-{uuid.uuid4().hex[:8]}"
    await _tenant(rls_harness.owner, tenant_a)
    await _tenant(rls_harness.owner, TENANT_B)
    async with tenant_session(rls_harness.restricted, tenant_a) as session:
        await STORE.save(
            session,
            tenant_a,
            backend="haiku_anthropic",
            endpoint=None,
            api_key_encrypted="enc-a",
            threshold=None,
        )
        await session.commit()

    async with tenant_session(rls_harness.restricted, TENANT_B) as session:
        assert await STORE.get(session, tenant_a) is None
        assert (await session.scalars(select(DecisionSettings))).all() == []
        await STORE.clear(session, tenant_a)
        await session.commit()

    async with tenant_session(rls_harness.restricted, tenant_a) as session:
        row = await STORE.get(session, tenant_a)
        assert row is not None and row.api_key_encrypted == "enc-a"


async def _machine(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(
            name="ada", email=f"ada-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
        )
        session.add(user)
        await session.flush()
        controller = await add_controller(session, user.id)
        await session.commit()
        return controller.id


async def test_a_machine_is_ready_only_once_it_reports_the_chosen_model(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    controller_id = await _machine(session_factory)
    async with session_factory() as session:
        saved = await STORE.save_machine(
            session,
            TENANT_ZERO_ID,
            controller_id=controller_id,
            model=MODEL,
            threshold=0.7,
        )
        assert (saved.backend, saved.controller_id, saved.model) == (
            "machine",
            controller_id,
            MODEL,
        )
        assert saved.machine_ready_at is None
        # Another model running there does not make this choice ready.
        assert not await STORE.mark_machine_ready(
            session, TENANT_ZERO_ID, controller_id, "another-model"
        )
        assert await STORE.mark_machine_ready(
            session, TENANT_ZERO_ID, controller_id, MODEL
        )
        # Once is enough: the time it became ready stays.
        assert not await STORE.mark_machine_ready(
            session, TENANT_ZERO_ID, controller_id, MODEL
        )
        await session.commit()

    async with session_factory() as session:
        row = await STORE.for_controller(session, TENANT_ZERO_ID, controller_id)
        assert row is not None and row.machine_ready_at is not None
        assert row.threshold == 0.7
        assert await STORE.for_controller(session, TENANT_ZERO_ID, "elsewhere") is None


async def test_choosing_the_same_machine_again_keeps_it_ready_and_another_starts_over(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    first = await _machine(session_factory)
    second = await _machine(session_factory)
    async with session_factory() as session:
        await STORE.save_machine(
            session, TENANT_ZERO_ID, controller_id=first, model=MODEL, threshold=None
        )
        await STORE.mark_machine_ready(session, TENANT_ZERO_ID, first, MODEL)
        again = await STORE.save_machine(
            session, TENANT_ZERO_ID, controller_id=first, model=MODEL, threshold=0.5
        )
        assert again.machine_ready_at is not None
        moved = await STORE.save_machine(
            session, TENANT_ZERO_ID, controller_id=second, model=MODEL, threshold=0.5
        )
        assert moved.machine_ready_at is None
        await STORE.mark_machine_ready(session, TENANT_ZERO_ID, second, MODEL)
        away = await STORE.save(
            session,
            TENANT_ZERO_ID,
            backend="none",
            endpoint=None,
            api_key_encrypted=None,
            threshold=None,
        )
        assert (away.controller_id, away.model, away.machine_ready_at) == (
            None,
            None,
            None,
        )
        await session.commit()


async def test_a_machine_needs_its_controller_and_model(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(ValueError, match="save_machine"):
            await STORE.save(
                session,
                TENANT_ZERO_ID,
                backend="machine",
                endpoint=None,
                api_key_encrypted=None,
                threshold=None,
            )
        session.add(DecisionSettings(tenant_id=TENANT_ZERO_ID, backend="machine"))
        with pytest.raises(IntegrityError, match="ck_decision_settings_machine"):
            await session.flush()


async def test_a_machine_in_another_workspace_cannot_be_chosen(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _tenant(session_factory, TENANT_B)
    controller_id = await _machine(session_factory)
    async with session_factory() as session:
        with pytest.raises(IntegrityError, match="fk_decision_settings_controller"):
            await STORE.save_machine(
                session,
                TENANT_B,
                controller_id=controller_id,
                model=MODEL,
                threshold=None,
            )
