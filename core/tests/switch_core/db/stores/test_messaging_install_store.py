"""Redeeming an install state is a race, and only one caller may win it.

The state is the only thing tying an authenticated "install this" to an
unauthenticated callback from the platform, and a signature alone cannot make
it single-use. This is where that property lives, so these run against a real
Postgres through the restricted role — a test that redeemed a state in Python
would prove nothing about the statement that actually runs.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.db.models import Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_install_store import (
    MessagingInstallClaimedError,
    MessagingInstallStateError,
    MessagingInstallStore,
)
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


class _Fixture:
    def __init__(self) -> None:
        self.tenant_a: str = ""
        self.tenant_b: str = ""
        self.user_id: str = ""
        self.workspace: str = ""


async def _two_tenants(owner: async_sessionmaker) -> _Fixture:
    fixture = _Fixture()
    suffix = uuid.uuid4().hex[:8]
    fixture.tenant_a = f"tenant-a-{suffix}"
    fixture.tenant_b = f"tenant-b-{suffix}"
    fixture.workspace = f"T-{suffix}"

    async with owner() as session:
        for tenant_id in (fixture.tenant_a, fixture.tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        user = User(name="installer", email=f"{suffix}@example.test", role="user")
        session.add(user)
        await session.flush()
        fixture.user_id = user.id
        await session.commit()
    return fixture


class TestStartingAnInstall:
    async def test_the_state_takes_its_tenant_from_the_session(
        self, rls_harness: RLSHarness
    ) -> None:
        """The caller never names a tenant; the bound session decides.

        This is the whole reason the start leg is the authenticated one.
        """
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state = await store.start_install(
                session, platform="slack", user_id=fixture.user_id
            )
            await session.commit()
            assert state.tenant_id == fixture.tenant_a


class TestRedeemingAState:
    async def test_a_state_redeems_once(self, rls_harness: RLSHarness) -> None:
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state_id = (
                await store.start_install(
                    session, platform="slack", user_id=fixture.user_id
                )
            ).id
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            redeemed = await store.redeem_state(
                session, state_id=state_id, platform="slack"
            )
            await session.commit()
            assert redeemed.consumed_at is not None

    async def test_replaying_it_is_refused(self, rls_harness: RLSHarness) -> None:
        """The attack. A captured state must not install a second workspace."""
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state_id = (
                await store.start_install(
                    session, platform="slack", user_id=fixture.user_id
                )
            ).id
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            await store.redeem_state(session, state_id=state_id, platform="slack")
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            with pytest.raises(MessagingInstallStateError, match="already been used"):
                await store.redeem_state(session, state_id=state_id, platform="slack")

    async def test_two_simultaneous_redemptions_produce_one_winner(
        self, rls_harness: RLSHarness
    ) -> None:
        """Sequential replay is the easy half; this is the one that needs the
        check and the write to be a single statement.

        Two callbacks arriving together would both read `consumed_at IS NULL`
        under a read-then-update, and both would proceed.
        """
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state_id = (
                await store.start_install(
                    session, platform="slack", user_id=fixture.user_id
                )
            ).id
            await session.commit()

        async def attempt() -> bool:
            async with tenant_session(
                rls_harness.restricted, fixture.tenant_a
            ) as session:
                try:
                    await store.redeem_state(
                        session, state_id=state_id, platform="slack"
                    )
                except MessagingInstallStateError:
                    return False
                await session.commit()
                return True

        outcomes = await asyncio.gather(attempt(), attempt())
        assert sum(outcomes) == 1

    async def test_an_expired_state_is_refused(self, rls_harness: RLSHarness) -> None:
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state = await store.start_install(
                session, platform="slack", user_id=fixture.user_id
            )
            state.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()
            state_id = state.id

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            with pytest.raises(MessagingInstallStateError, match="expired"):
                await store.redeem_state(session, state_id=state_id, platform="slack")

    async def test_another_tenant_cannot_redeem_it(
        self, rls_harness: RLSHarness
    ) -> None:
        """The second check on the signature.

        A state's tenant is established by the signature before this runs, so
        reaching here with the wrong one means the signature was forged or the
        key leaked. Row-level security still refuses, independently.
        """
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state_id = (
                await store.start_install(
                    session, platform="slack", user_id=fixture.user_id
                )
            ).id
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            with pytest.raises(MessagingInstallStateError):
                await store.redeem_state(session, state_id=state_id, platform="slack")

    async def test_a_state_cannot_be_redeemed_on_another_platform(
        self, rls_harness: RLSHarness
    ) -> None:
        """The path a callback is served on does not get to pick the state."""
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            state_id = (
                await store.start_install(
                    session, platform="slack", user_id=fixture.user_id
                )
            ).id
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            with pytest.raises(MessagingInstallStateError):
                await store.redeem_state(session, state_id=state_id, platform="teams")


class TestRecordingAnInstall:
    async def test_a_claimed_workspace_raises_something_showable(
        self, rls_harness: RLSHarness
    ) -> None:
        """An IntegrityError reaching a request handler is a 500 and a
        traceback; this failure is ordinary and has to read as one."""
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            await store.record_install(
                session,
                platform="slack",
                external_workspace_id=fixture.workspace,
                encrypted_bot_token="ciphertext",
                scopes="chat:write",
                user_id=fixture.user_id,
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            with pytest.raises(MessagingInstallClaimedError, match="already connected"):
                await store.record_install(
                    session,
                    platform="slack",
                    external_workspace_id=fixture.workspace,
                    encrypted_bot_token="ciphertext",
                    scopes="chat:write",
                    user_id=fixture.user_id,
                )

    async def test_only_the_owning_tenant_reads_it_back(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_tenants(rls_harness.owner)
        store = MessagingInstallStore()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            await store.record_install(
                session,
                platform="slack",
                external_workspace_id=fixture.workspace,
                encrypted_bot_token="ciphertext",
                scopes="chat:write",
                user_id=fixture.user_id,
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
            mine = await store.get_for_workspace(
                session, platform="slack", external_workspace_id=fixture.workspace
            )
            assert mine is not None

        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            theirs = await store.get_for_workspace(
                session, platform="slack", external_workspace_id=fixture.workspace
            )
            assert theirs is None
