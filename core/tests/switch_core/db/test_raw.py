"""`RawStatement` (`db/raw.py`): a statement compiled by SQLAlchemy once and run
by asyncpg on the session's own connection.

What has to hold for it to stand in for `session.execute`: it runs in the
session's transaction, under its tenant, with row-level security applying; its
parameters and columns are converted as SQLAlchemy converts them; it is timed
as every other statement is; and what it cannot do the same way is refused
rather than done differently.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import pytest
from sqlalchemy import Boolean, Integer, bindparam, func, literal, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, RoomGroup, Tenant
from switch_core.db.raw import RawStatement
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.tenant_session import TenantBindingDriftError
from switch_core.observability.catalogue import DB_QUERY_DURATION
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness

TENANT = TENANT_ZERO_ID

_GROUP_BY_ID = RawStatement(
    select(RoomGroup.id, RoomGroup.tenant_id, RoomGroup.name).where(
        RoomGroup.id == bindparam("id")
    )
)
_GROUPS = RawStatement(select(RoomGroup.id, RoomGroup.tenant_id))


async def _make_tenant(owner: async_sessionmaker[AsyncSession], tenant_id: str) -> None:
    async with owner() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()


async def _group(session: AsyncSession, name: str) -> str:
    group = await RoomGroupStore().create(
        session, name=name, description=None, color=None, parent_group_id=None
    )
    return group.id


async def test_it_reads_what_its_transaction_wrote(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with tenant_session(session_factory, TENANT) as session:
        group_id = await _group(session, "uncommitted")
        rows = await _GROUP_BY_ID.all(session, {"id": group_id})
        await session.rollback()

    assert [(row.id, row.tenant_id, row.name) for row in rows] == [
        (group_id, TENANT, "uncommitted")
    ]
    # Read by position as well as by name, as SQLAlchemy's rows are.
    assert rows[0][2] == "uncommitted"


async def test_row_level_security_applies(rls_harness: RLSHarness) -> None:
    tenant_a, tenant_b = (f"tenant-{uuid.uuid4().hex[:8]}" for _ in range(2))
    for tenant_id in (tenant_a, tenant_b):
        await _make_tenant(rls_harness.owner, tenant_id)
        async with tenant_session(rls_harness.restricted, tenant_id) as session:
            await _group(session, tenant_id)
            await session.commit()

    async with tenant_session(rls_harness.restricted, tenant_a) as session:
        rows = await _GROUPS.all(session, {})

    assert {row.tenant_id for row in rows} == {tenant_a}


async def test_parameters_and_columns_are_converted_as_sqlalchemy_converts_them(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    statement = select(
        bindparam("document", type_=JSONB).label("document"),
        literal({"nested": [1, "two", None]}, JSONB).label("constant"),
        bindparam("flag", type_=Boolean).label("flag"),
        func.now().label("at"),
        literal(7, Integer).label("seven"),
    )
    values = {"document": {"a": [1, 2], "b": {"c": True}}, "flag": True}

    async with tenant_session(session_factory, TENANT) as session:
        raw = await RawStatement(statement).all(session, values)
        through_sqlalchemy = (await session.execute(statement, values)).all()

    assert [tuple(row) for row in raw] == [tuple(row) for row in through_sqlalchemy]
    assert raw[0].document == {"a": [1, 2], "b": {"c": True}}
    assert isinstance(raw[0].at, datetime)
    assert raw[0].at.tzinfo is not None


async def test_it_is_timed_as_every_statement_is(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    registry = MetricsRegistry()
    install(registry)
    try:
        async with tenant_session(session_factory, TENANT) as session:
            await _GROUPS.all(session, {})
    finally:
        uninstall()

    timed = {
        point.attributes["operation"]: point.count
        for payload in registry.collect()
        if payload.name == DB_QUERY_DURATION.name
        for point in payload.histograms
    }
    assert timed.get("select") == 1


@pytest.mark.no_ambient_tenant
async def test_it_refuses_to_run_with_no_tenant_bound(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(RuntimeError, match="tenant bound"):
            await _GROUPS.all(session, {})


async def test_it_refuses_a_tenant_bound_after_the_transaction_began(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with tenant_session(session_factory, TENANT) as session:
        await _GROUPS.all(session, {})
        with tenant_scope("another-tenant"), pytest.raises(TenantBindingDriftError):
            await _GROUPS.all(session, {})


async def test_it_refuses_a_missing_parameter(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with tenant_session(session_factory, TENANT) as session:
        with pytest.raises(KeyError, match="'id'"):
            await _GROUP_BY_ID.all(session, {})


async def test_it_refuses_a_statement_that_cannot_be_compiled_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    expanding = RawStatement(
        select(RoomGroup.id).where(RoomGroup.id.in_(bindparam("ids", expanding=True)))
    )
    unnamed = RawStatement(select(func.count()))
    async with tenant_session(session_factory, TENANT) as session:
        with pytest.raises(ValueError, match="any"):
            await expanding.all(session, {"ids": ["x"]})
        with pytest.raises(ValueError, match="named"):
            await unnamed.all(session, {})
