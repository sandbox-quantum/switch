"""The `after_begin` hook (`db/tenant_session.py`): it stamps `app.tenant_id`
on a transaction while the bound context says so, releases it when that
transaction ends however it ends, and — the exact prior-art bug this design
exists to prevent — must not let a tenant leak from one session into the next
session that reuses the same pooled connection.

Uses its own single-connection engine (`pool_size=1, max_overflow=0`) rather
than the shared `session_factory` fixture, so "the next session reuses the
same physical connection" is guaranteed rather than incidental — verified
directly below via `pg_backend_pid()`. Tenant A followed by *tenant B* on that
one connection is the case that distinguishes "released" from merely
"overwritten"; tenant A followed by nothing cannot tell them apart.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

from switch_core.db import tenant_session
from switch_core.db.base import Base
from switch_core.db.engine import create_session_factory
from switch_core.db.models import Client, Tenant, User
from switch_core.tenant_context import tenant_scope

TENANT_A = "tenant-hook-a"
TENANT_B = "tenant-hook-b"


@pytest_asyncio.fixture
async def single_connection_session_factory(
    postgres_url: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(postgres_url, pool_size=1, max_overflow=0)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        # Goes through the production factory constructor, same as the shared
        # fixture. The hook itself is registered on import, not by this call —
        # `TestTheHookIsRegisteredByImportAlone` is what pins that.
        yield create_session_factory(engine)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


async def _current_setting(session: AsyncSession) -> str | None:
    result = await session.execute(
        text("SELECT current_setting('app.tenant_id', true)")
    )
    value = result.scalar_one()
    return value or None


async def _pid_and_setting(session: AsyncSession) -> tuple[int, str | None]:
    result = await session.execute(
        text("SELECT pg_backend_pid(), current_setting('app.tenant_id', true)")
    )
    pid, value = result.one()
    return pid, (value or None)


class TestTheHookIsRegisteredByImportAlone:
    """Registration must not depend on anyone calling anything.

    Attached as a side effect of `create_session_factory` instead, a process
    that builds its own `async_sessionmaker` would silently get no tenant on
    any session — the hook would fail open, and nothing would say so.
    """

    def test_importing_the_module_attaches_the_listener(self) -> None:
        assert event.contains(
            Session, "after_begin", tenant_session._set_tenant_on_begin
        )

    async def test_a_hand_built_sessionmaker_is_covered_too(
        self, postgres_url: str
    ) -> None:
        engine = create_async_engine(postgres_url)
        try:
            # Deliberately not create_session_factory.
            factory = async_sessionmaker(bind=engine, expire_on_commit=False)
            async with factory() as session:
                with tenant_scope(TENANT_A):
                    assert await _current_setting(session) == TENANT_A
                await session.commit()
        finally:
            await engine.dispose()

    async def test_registering_twice_does_not_stamp_twice(
        self, postgres_url: str
    ) -> None:
        """The idempotence guard, asserted on what it is for rather than on a
        flag: a second listener would issue `set_config` twice per
        transaction, on every transaction the process ever opens."""
        engine = create_async_engine(postgres_url)
        statements: list[str] = []

        @event.listens_for(engine.sync_engine, "before_cursor_execute")
        def _record(
            conn: object,
            cursor: object,
            statement: str,
            parameters: object,
            context: object,
            executemany: bool,
        ) -> None:
            statements.append(statement)

        try:
            tenant_session.register_tenant_session_hook()
            factory = async_sessionmaker(bind=engine, expire_on_commit=False)
            async with factory() as session:
                with tenant_scope(TENANT_A):
                    await _current_setting(session)
                await session.commit()
        finally:
            await engine.dispose()

        assert sum("set_config" in statement for statement in statements) == 1


class TestTenantSetOnBeginAndReleasedOnCommit:
    async def test_tenant_is_visible_inside_the_transaction(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                assert await _current_setting(session) == TENANT_A
            await session.commit()

    async def test_tenant_is_released_once_the_transaction_commits(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                await _current_setting(session)  # begins the transaction
            await session.commit()

            # Same session, same connection, a new transaction — and by now
            # the context that set it has been unbound (the `with` above
            # exited before the commit).
            assert await _current_setting(session) is None


class TestTenantIsReleasedWhenATransactionRollsBack:
    """`is_local=true` releases the setting at the end of the transaction
    whichever way it ends. A rollback path that kept it would leave the value
    on a connection heading straight back to the pool."""

    async def test_an_explicit_rollback_releases_it(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                assert await _current_setting(session) == TENANT_A
                await session.rollback()

            # A new transaction on the same connection, nothing bound.
            assert await _current_setting(session) is None

    async def test_an_exception_out_of_the_session_releases_it(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        pids: list[int] = []

        with pytest.raises(RuntimeError, match="boom"):
            async with single_connection_session_factory() as session:
                with tenant_scope(TENANT_A):
                    pid, setting = await _pid_and_setting(session)
                    pids.append(pid)
                    assert setting == TENANT_A
                    raise RuntimeError("boom")

        # The session closed by rolling back, and handed the connection back.
        async with single_connection_session_factory() as session:
            pid, setting = await _pid_and_setting(session)
            assert pid == pids[0], "the pool did not actually reuse the connection"
            assert setting is None


class TestNoLeakAcrossAPooledConnection:
    async def test_a_reused_connection_does_not_inherit_the_previous_tenant(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                pid_a, setting_a = await _pid_and_setting(session)
            assert setting_a == TENANT_A
            await session.commit()

        # A second session, opened after the first is closed, with no tenant
        # bound at all — e.g. a system session doing auth resolution, or a
        # background job that has not been converted to bind one yet. With a
        # pool of exactly one connection this must be the same physical
        # connection the first session used.
        async with single_connection_session_factory() as session:
            pid_b, setting_b = await _pid_and_setting(session)
            assert pid_b == pid_a, "the pool did not actually reuse the connection"
            assert setting_b is None

    async def test_a_reused_connection_carries_the_second_tenant_not_the_first(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The case the test above cannot see.

        "A, then nothing" passes whether the hook releases the old value or
        merely overwrites it, because there is no new value to overwrite it
        with. "A, then B" fails if release is broken *and* B's `set_config`
        ever fails to run — and, more usefully, pins that B is what the
        connection reports rather than A lingering underneath it.
        """
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                pid_a, setting_a = await _pid_and_setting(session)
            assert setting_a == TENANT_A
            await session.commit()

        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_B):
                pid_b, setting_b = await _pid_and_setting(session)
            assert pid_b == pid_a, "the pool did not actually reuse the connection"
            assert setting_b == TENANT_B
            await session.commit()

        # And once neither is bound, the connection reports neither.
        async with single_connection_session_factory() as session:
            pid_c, setting_c = await _pid_and_setting(session)
            assert pid_c == pid_a
            assert setting_c is None


class TestABindingThatArrivesTooLateIsRefused:
    """`set_config` rides `after_begin`, so it is issued once — when the
    transaction opens. Binding a tenant after that rebinds a contextvar and
    nothing the database can see, and the call site looks correct while every
    statement runs under whatever the transaction was actually told.

    On a connection Postgres exempts from the policies (every environment
    before the runtime role, and the whole unit suite still) both halves of
    that are invisible: no policy narrows the reads, none rejects the writes.
    So the process refuses rather than leaving it to a reviewer's eye —
    `TenantBindingDriftError`, from two hooks, because a read and a write take
    different paths out of a `Session`.
    """

    async def test_a_read_after_a_late_binding_raises(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with single_connection_session_factory() as session:
            # Opens the transaction with nothing bound; the hook stamps None.
            assert (await _pid_and_setting(session))[1] is None
            with tenant_scope(TENANT_A):
                with pytest.raises(tenant_session.TenantBindingDriftError) as raised:
                    await session.execute(text("SELECT 1"))
        assert "opened with tenant None" in str(raised.value)
        assert TENANT_A in str(raised.value)

    async def test_a_flush_after_a_late_binding_raises(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The path `do_orm_execute` does not see, and the one that matters
        most: the unit of work emits its INSERTs to the connection directly
        rather than through `Session.execute`. A late binding followed only by
        `add` and `commit` is exactly how a row comes to claim one tenant on a
        transaction that carries another."""
        async with single_connection_session_factory() as session:
            assert (await _pid_and_setting(session))[1] is None
            with tenant_scope(TENANT_A):
                session.add(Tenant(id=TENANT_A, slug=TENANT_A, name=TENANT_A))
                with pytest.raises(tenant_session.TenantBindingDriftError):
                    await session.flush()

    async def test_rebinding_the_same_tenant_is_not_drift(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A redundant binding is not a wrong one. `tenant_session` nested
        inside a `tenant_scope` for the same tenant is an ordinary shape on the
        delivery path, and refusing it would be a false positive."""
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                assert (await _pid_and_setting(session))[1] == TENANT_A
                with tenant_scope(TENANT_A):
                    await session.execute(text("SELECT 1"))
            await session.commit()

    async def test_a_commit_clears_the_stamp_so_the_next_binding_is_free(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The escape the error message offers has to actually work. A session
        reused after a commit opens a fresh transaction, which gets its own
        `set_config` and its own stamp, so binding a different tenant between
        the two is correct rather than drift."""
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                assert (await _pid_and_setting(session))[1] == TENANT_A
            await session.commit()
            with tenant_scope(TENANT_B):
                assert (await _pid_and_setting(session))[1] == TENANT_B
                await session.commit()


class TestARowFromAnotherTenantIsRefusedFromTheIdentityMap:
    """`Session.get` answered from the identity map is the one read that
    reaches neither the policy nor the drift check.

    Both of the guarantees this design rests on are downstream of a round
    trip: the row-level-security policy is the server's, and the drift hooks
    fire on `Session.execute` and on a flush. A `get` whose primary key is
    already in the session's identity map issues no statement, opens no
    transaction and flushes nothing, so it goes past all three and hands back
    an object loaded under whatever tenant was bound at the time.

    `db/engine.create_session_factory` puts `TenantCheckedSession` under every
    session in the process for exactly this. The first test below is the
    defect, asserted against a session built the plain way, so this file
    records what the subclass is worth rather than only that it is wired in.
    """

    @staticmethod
    async def _two_tenants_and_a_client(
        factory: async_sessionmaker[AsyncSession],
    ) -> str:
        """Tenant A, tenant B, and one client row in A. Returns the client id."""
        client_id = "client-in-tenant-a"
        async with factory() as session:
            for tenant_id in (TENANT_A, TENANT_B):
                session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            # Flushed before the client is added: nothing declares a
            # relationship between the two mappers, so the unit of work has no
            # dependency to sort them by and is free to insert the child first.
            await session.flush()
            session.add(
                Client(
                    id=client_id,
                    tenant_id=TENANT_A,
                    matrix_user_id=f"@{client_id}:localhost",
                    display_name="a client",
                    type="agent",
                )
            )
            await session.commit()
        return client_id

    async def test_a_plain_session_hands_back_the_other_tenants_row(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The defect, stated as a passing test so the fix has something to be
        a fix of. A session built without `TenantCheckedSession` answers the
        second `get` from the identity map: no statement reaches Postgres, so
        the policy never sees it, and tenant B is handed tenant A's row."""
        client_id = await self._two_tenants_and_a_client(
            single_connection_session_factory
        )
        engine = single_connection_session_factory.kw["bind"]
        plain = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with plain() as session:
            with tenant_scope(TENANT_A):
                loaded = await session.get(Client, client_id)
                assert loaded is not None
                await session.commit()
            with tenant_scope(TENANT_B):
                leaked = await session.get(Client, client_id)
        assert leaked is loaded
        assert leaked is not None and leaked.tenant_id == TENANT_A

    async def test_the_production_factory_refuses_it(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        client_id = await self._two_tenants_and_a_client(
            single_connection_session_factory
        )
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                loaded = await session.get(Client, client_id)
                assert loaded is not None
                await session.commit()
            with tenant_scope(TENANT_B):
                with pytest.raises(
                    tenant_session.CrossTenantIdentityMapError
                ) as raised:
                    await session.get(Client, client_id)
        message = str(raised.value)
        assert TENANT_A in message and TENANT_B in message

    async def test_the_same_tenant_reading_its_own_row_is_untouched(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The check has to be silent on the shape every request actually
        takes, or it is a false positive on the whole codebase."""
        client_id = await self._two_tenants_and_a_client(
            single_connection_session_factory
        )
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                loaded = await session.get(Client, client_id)
                assert loaded is not None
                await session.commit()
                again = await session.get(Client, client_id)
                assert again is not None and again.tenant_id == TENANT_A

    async def test_a_get_that_actually_queried_is_not_second_guessed(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The check must fire on the identity map and nowhere else.

        This fixture connects as the container's superuser, whom Postgres
        exempts from every policy — the same connection the whole unit suite
        uses, and the same one every fan-out has to filter its own results on
        (`db/tenant_lookup.py`). So a `get` that really goes to the database
        can and does return another tenant's row here. Refusing that would
        impose the policy's semantics on the owner connection, which this
        design does not do anywhere else, and would break every test that
        arranges a second tenant's fixture rows.

        `expire_all` is what forces the round trip: the object is still in the
        identity map, but its attributes are gone, so `get` has to reload it.
        """
        client_id = await self._two_tenants_and_a_client(
            single_connection_session_factory
        )
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                loaded = await session.get(Client, client_id)
                assert loaded is not None
                await session.commit()
            session.expire_all()
            with tenant_scope(TENANT_B):
                fetched = await session.get(Client, client_id)
        assert fetched is not None and fetched.tenant_id == TENANT_A

    async def test_a_global_row_is_not_refused(
        self, single_connection_session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`users` carries no tenant and no policy — a person is global — so
        there is nothing to compare and nothing to refuse. Reading one from
        two tenants is the ordinary case, not a leak."""
        async with single_connection_session_factory() as session:
            for tenant_id in (TENANT_A, TENANT_B):
                session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            session.add(
                User(
                    id="a-person",
                    name="A Person",
                    email="person@example.invalid",
                    role="admin",
                )
            )
            await session.commit()
        async with single_connection_session_factory() as session:
            with tenant_scope(TENANT_A):
                assert await session.get(User, "a-person") is not None
                await session.commit()
            with tenant_scope(TENANT_B):
                assert await session.get(User, "a-person") is not None
