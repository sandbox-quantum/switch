"""Sign-in flows in Postgres, as two switch-core processes see them.

Through the restricted runtime role, so the tenant policies apply: the
browser's steps find a flow's tenant through `tenant_of_sign_in_flow` and
nothing else, and a superuser connection would pass whether or not that
worked.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.sign_in_flows import (
    MAX_FLOWS,
    FlowGoneError,
    FlowsBusyError,
    FlowUsedError,
    SignInFlows,
    StoredFlow,
    digest,
)
from switch_core.db.models import SignInFlow, Tenant, User
from tests.conftest import TEST_KEYRING, RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


async def _tenants_and_user(rls_harness: RLSHarness) -> tuple[str, str, str]:
    suffix = uuid.uuid4().hex[:8]
    tenant_a, tenant_b = f"a-{suffix}", f"b-{suffix}"
    async with rls_harness.owner() as session:
        for tenant_id in (tenant_a, tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()
        user = User(name="Ada", email=f"ada-{suffix}@example.test", role="user")
        session.add(user)
        await session.commit()
        return tenant_a, tenant_b, user.id


async def _person(rls_harness: RLSHarness, name: str) -> str:
    async with rls_harness.owner() as session:
        user = User(
            name=name,
            email=f"{name.lower()}-{uuid.uuid4().hex[:8]}@example.test",
            role="user",
        )
        session.add(user)
        await session.commit()
        return user.id


async def _start(
    flows: SignInFlows, tenant_id: str, user_id: str, state: str
) -> StoredFlow:
    return await flows.start(
        kind="service",
        service="example",
        tenant_id=tenant_id,
        user_id=user_id,
        state=state,
        mode="core",
        port=43123,
        redirect_uri="https://switch.example.com/callback",
        owner_label="Ada in A",
        details={"name": "Example"},
        completion_secret="completion-secret",
    )


class _HeldBeforeCommit:
    """Sessions that stop just before they commit until let go, with their
    transaction, and any lock taken in it, still open."""

    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = factory
        self.reached = asyncio.Event()
        self.release = asyncio.Event()

    def __call__(self) -> AsyncSession:
        session = self._factory()
        commit = session.commit

        async def held() -> None:
            self.reached.set()
            await self.release.wait()
            await commit()

        session.commit = held  # type: ignore[method-assign]
        return session


async def _start_beside_a_held_one(
    rls_harness: RLSHarness,
    tenant_id: str,
    held: tuple[str, str],
    other: tuple[str, str],
) -> list[StoredFlow | BaseException]:
    """Start two flows in `tenant_id` from two processes, each a
    `(user_id, state)`. The first is held open just before it commits, long
    enough for the second to finish if nothing makes it wait for the first."""
    gate = _HeldBeforeCommit(rls_harness.restricted)
    first = asyncio.create_task(
        _start(SignInFlows(gate, TEST_KEYRING), tenant_id, *held)  # type: ignore[arg-type]
    )
    await asyncio.wait_for(gate.reached.wait(), 5)
    second = asyncio.create_task(
        _start(SignInFlows(rls_harness.restricted, TEST_KEYRING), tenant_id, *other)
    )
    await asyncio.sleep(0.3)
    gate.release.set()
    return await asyncio.gather(first, second, return_exceptions=True)


async def test_a_flow_started_by_one_process_is_found_by_another(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, tenant_b, user_id = await _tenants_and_user(rls_harness)
    first = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    second = SignInFlows(rls_harness.restricted, TEST_KEYRING)

    started = await _start(first, tenant_a, user_id, "state-1")
    # The browser's step carries only the state, and reaches the other process.
    found = await second.find("state-1")

    assert found.tenant_id == tenant_a
    assert found.verifier == started.verifier
    assert found.holds_secret("completion-secret")
    assert not found.holds_secret("something-else")
    with pytest.raises(FlowGoneError):
        await second.get("state-1", tenant_b)
    with pytest.raises(FlowGoneError):
        await second.find("no-such-state")


async def test_two_processes_racing_for_one_step_take_it_once(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, _, user_id = await _tenants_and_user(rls_harness)
    first = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    second = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    flow = await _start(first, tenant_a, user_id, "state-2")

    taken = await asyncio.gather(
        first.advance(flow, expect=("pending",), to="authorizing", changes={}),
        second.advance(flow, expect=("pending",), to="authorizing", changes={}),
    )

    assert sorted(result is None for result in taken) == [False, True]


async def test_two_starts_by_one_person_side_by_side_leave_one_flow(
    rls_harness: RLSHarness,
) -> None:
    """Neither start sees the other's flow while it is uncommitted, so unless
    the second waits for the first, both delete nothing and both insert."""
    tenant_a, _, user_id = await _tenants_and_user(rls_harness)

    started = await _start_beside_a_held_one(
        rls_harness, tenant_a, (user_id, "state-5"), (user_id, "state-6")
    )

    assert not [result for result in started if isinstance(result, BaseException)]
    async with rls_harness.owner() as session:
        states = await session.scalars(
            select(SignInFlow.id).where(SignInFlow.tenant_id == tenant_a)
        )
        assert states.all() == ["state-6"]


async def test_two_starts_side_by_side_at_the_cap_let_one_in(
    rls_harness: RLSHarness,
) -> None:
    """Each counts the workspace's flows before the other's is committed, so
    unless the second waits for the first, both take the one place left."""
    tenant_a, _, user_id = await _tenants_and_user(rls_harness)
    await _start(
        SignInFlows(rls_harness.restricted, TEST_KEYRING), tenant_a, user_id, "state-7"
    )
    async with rls_harness.owner() as session:
        template = await session.scalar(select(SignInFlow))
        assert template is not None
        columns = {
            column.key: getattr(template, column.key)
            for column in SignInFlow.__table__.columns
        }
        for i in range(MAX_FLOWS - 2):
            session.add(SignInFlow(**{**columns, "id": f"filler-{i}"}))
        await session.commit()
    grace = await _person(rls_harness, "Grace")
    alan = await _person(rls_harness, "Alan")

    started = await _start_beside_a_held_one(
        rls_harness, tenant_a, (grace, "state-8"), (alan, "state-9")
    )

    assert [type(result) for result in started].count(FlowsBusyError) == 1
    async with rls_harness.owner() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(SignInFlow)
                .where(SignInFlow.tenant_id == tenant_a)
            )
            == MAX_FLOWS
        )


async def test_a_state_is_used_once_even_in_another_workspace(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, tenant_b, user_id = await _tenants_and_user(rls_harness)
    flows = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    await _start(flows, tenant_a, user_id, "state-3")

    with pytest.raises(FlowUsedError):
        await _start(flows, tenant_b, user_id, "state-3")


async def test_secrets_are_stored_encrypted_or_hashed(
    rls_harness: RLSHarness,
) -> None:
    tenant_a, _, user_id = await _tenants_and_user(rls_harness)
    flows = SignInFlows(rls_harness.restricted, TEST_KEYRING)
    flow = await _start(flows, tenant_a, user_id, "state-4")
    await flows.advance(
        flow,
        expect=("pending",),
        to="ready",
        changes={"encrypted_result": flows.seal({"refresh_token": "SYNTHETIC"})},
    )

    async with rls_harness.owner() as session:
        row = await session.scalar(select(SignInFlow).where(SignInFlow.id == "state-4"))
    assert row is not None
    assert flow.verifier not in row.encrypted_verifier
    assert row.completion_secret_hash == digest("completion-secret")
    assert "SYNTHETIC" not in (row.encrypted_result or "")
    assert (await flows.find("state-4")).result == {"refresh_token": "SYNTHETIC"}
