"""Change notices reach the owner's Console when their managed agents or
machines change, and only then."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.management.service import _status_signature
from switch_core.signals import SignalBus
from switch_core.user_changes import (
    MACHINE,
    MANAGED_AGENT,
    USER_CHANGED_SIGNAL,
    LocalUserChanges,
    SignalUserChanges,
    UserChange,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    enroll_console,
    provider,
    report_status,
    report_status_only,
    status_report,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class TestLocalUserChanges:
    def test_a_notice_reaches_only_that_users_subscriptions_in_that_tenant(
        self,
    ) -> None:
        feed = LocalUserChanges()
        mine = feed.subscribe("t1", "ada")
        other_user = feed.subscribe("t1", "bob")
        other_tenant = feed.subscribe("t2", "ada")
        feed.publish("t1", "ada", MANAGED_AGENT, "a1")
        assert mine.drain() == [UserChange(MANAGED_AGENT, "a1")]
        assert other_user.drain() == []
        assert other_tenant.drain() == []

    def test_the_same_change_twice_is_sent_once(self) -> None:
        feed = LocalUserChanges()
        subscription = feed.subscribe("t1", "ada")
        feed.publish("t1", "ada", MACHINE, "m1")
        feed.publish("t1", "ada", MACHINE, "m1")
        assert subscription.drain() == [UserChange(MACHINE, "m1")]
        assert not subscription.wake.is_set()

    def test_an_unread_subscription_collapses_to_one_notice_per_kind(self) -> None:
        feed = LocalUserChanges()
        subscription = feed.subscribe("t1", "ada")
        for i in range(100):
            feed.publish("t1", "ada", MANAGED_AGENT, f"a{i}")
        feed.publish("t1", "ada", MACHINE, "m1")
        drained = subscription.drain()
        assert UserChange(MANAGED_AGENT, None) in drained
        assert len(drained) <= 2

    def test_a_closed_subscription_hears_nothing_and_is_forgotten(self) -> None:
        feed = LocalUserChanges()
        subscription = feed.subscribe("t1", "ada")
        subscription.close()
        feed.publish("t1", "ada", MACHINE, "m1")
        assert subscription.drain() == []
        assert feed.subscriber_count("t1", "ada") == 0

    def test_everything_tells_every_subscription_every_kind(self) -> None:
        feed = LocalUserChanges()
        ada = feed.subscribe("t1", "ada")
        bob = feed.subscribe("t2", "bob")
        feed.publish("t1", "ada", MACHINE, "m1")
        feed.publish_everything()
        for subscription in (ada, bob):
            drained = subscription.drain()
            assert UserChange(MANAGED_AGENT, None) in drained
            assert UserChange(MACHINE, None) in drained


DELIVERY_TIMEOUT = 10.0


class _Process:
    """One switch-core process's share: its bus and the subscriptions it holds."""

    def __init__(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        self.bus = SignalBus(
            session_factory,
            lambda: create_async_engine(postgres_url, poolclass=NullPool),
            process_id=str(uuid.uuid4()),
        )
        self.local = LocalUserChanges()
        self.publisher = SignalUserChanges(local=self.local, bus=self.bus)


@pytest.fixture
async def two_processes(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[tuple[_Process, _Process]]:
    first = _Process(postgres_url, session_factory)
    second = _Process(postgres_url, session_factory)
    for process in (first, second):
        await process.bus.start()
    for process in (first, second):
        await asyncio.wait_for(process.bus.connected.wait(), DELIVERY_TIMEOUT)
    yield first, second
    await first.bus.stop()
    await second.bus.stop()


async def _woken(subscription: object) -> None:
    await asyncio.wait_for(subscription.wake.wait(), DELIVERY_TIMEOUT)  # type: ignore[attr-defined]


class TestAcrossProcesses:
    async def test_a_notice_published_in_one_process_reaches_a_socket_in_another(
        self, two_processes: tuple[_Process, _Process]
    ) -> None:
        sender, receiver = two_processes
        there = receiver.local.subscribe("t1", "ada")
        sender.publisher.publish("t1", "ada", MANAGED_AGENT, "a1")
        await _woken(there)
        assert there.drain() == [UserChange(MANAGED_AGENT, "a1")]

    async def test_the_sending_process_tells_its_own_sockets_at_once(
        self, two_processes: tuple[_Process, _Process]
    ) -> None:
        sender, receiver = two_processes
        here = sender.local.subscribe("t1", "ada")
        there = receiver.local.subscribe("t1", "ada")
        sender.publisher.publish("t1", "ada", MACHINE, "m1")
        # Before the bus has carried anything: told locally, not by the bus.
        assert here.drain() == [UserChange(MACHINE, "m1")]
        await _woken(there)
        assert there.drain() == [UserChange(MACHINE, "m1")]
        # The bus does not bring it back to the sender a second time.
        await asyncio.sleep(0.2)
        assert here.drain() == []

    async def test_only_that_users_sockets_in_that_tenant_hear_it(
        self, two_processes: tuple[_Process, _Process]
    ) -> None:
        sender, receiver = two_processes
        mine = receiver.local.subscribe("t1", "ada")
        other_user = receiver.local.subscribe("t1", "bob")
        other_tenant = receiver.local.subscribe("t2", "ada")
        sender.publisher.publish("t1", "ada", MACHINE, "m1")
        await _woken(mine)
        assert other_user.drain() == []
        assert other_tenant.drain() == []

    async def test_a_kind_this_process_does_not_know_is_ignored(
        self, two_processes: tuple[_Process, _Process]
    ) -> None:
        sender, receiver = two_processes
        there = receiver.local.subscribe("t1", "ada")
        sender.bus.publish(
            USER_CHANGED_SIGNAL, tenant_id="t1", user_id="ada", change="hat", id="h1"
        )
        sender.publisher.publish("t1", "ada", MACHINE, "m1")
        await _woken(there)
        assert there.drain() == [UserChange(MACHINE, "m1")]

    async def test_a_listener_reconnecting_tells_its_sockets_to_read_everything(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Notices sent while the listener was down are gone, so each socket
        here is told that anything may have changed."""
        bus = SignalBus(session_factory, lambda: None, process_id="p")  # type: ignore[arg-type,return-value]
        local = LocalUserChanges()
        SignalUserChanges(local=local, bus=bus)
        subscription = local.subscribe("t1", "ada")
        await bus._resync_all()
        assert set(subscription.drain()) == {
            UserChange(MANAGED_AGENT, None),
            UserChange(MACHINE, None),
        }


class TestStatusSignature:
    def test_free_space_and_report_times_do_not_count_as_a_change(self) -> None:
        first = status_report(1)
        second = status_report(2)
        second["observed_at"] = "2030-01-01T00:00:00Z"
        second["machine"]["disk_free_bytes"] += 1
        second["machine"]["mem_free_bytes"] += 1
        for entry in second["providers"]:
            entry["checked_at"] = "2030-01-01T00:00:00Z"
        assert _status_signature(first) == _status_signature(second)

    def test_a_provider_signing_out_counts(self) -> None:
        first = status_report(1, providers=[provider("claude")])
        second = status_report(2, providers=[provider("claude", auth="expired")])
        assert _status_signature(first) != _status_signature(second)


class TestManagementNotices:
    async def test_creating_a_managed_agent_tells_its_owner(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        subscription = harness.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
        async with harness.client() as client:
            response = await create_managed_agent(
                client, owner, name="scout", controller_id=None
            )
        assert response.status_code == 201, response.text
        agent_id = response.json()["agent_id"]
        assert UserChange(MANAGED_AGENT, agent_id) in subscription.drain()

    async def test_moving_and_deleting_a_managed_agent_tell_its_owner(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1)
            created = await create_managed_agent(
                client, owner, name="scout", controller_id=None
            )
            agent_id = created.json()["agent_id"]
            subscription = harness.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
            moved = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"controller_id": controller.controller_id},
                cookies=cookies_for(owner),
            )
            assert moved.status_code == 200, moved.text
            assert UserChange(MANAGED_AGENT, agent_id) in subscription.drain()
            deleted = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
            assert deleted.status_code in (200, 204), deleted.text
        assert UserChange(MANAGED_AGENT, agent_id) in subscription.drain()

    async def test_enrolling_renaming_and_revoking_a_machine_tell_its_owner(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        subscription = harness.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            machine = UserChange(MACHINE, controller.controller_id)
            assert machine in subscription.drain()
            renamed = await client.patch(
                f"/gateway/management/controllers/{controller.controller_id}",
                json={"name": "studio"},
                cookies=cookies_for(owner),
            )
            assert renamed.status_code == 200, renamed.text
            assert machine in subscription.drain()
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            assert revoked.status_code in (200, 204), revoked.text
        assert machine in subscription.drain()

    async def test_a_status_report_tells_the_owner_only_when_something_changed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            subscription = harness.user_changes.subscribe(TENANT_ZERO_ID, owner.id)
            await report_status_only(
                client, controller, 2, providers=[provider("claude")]
            )
            assert subscription.drain() == []
            await report_status_only(
                client, controller, 3, providers=[provider("claude", auth="expired")]
            )
        assert subscription.drain() == [UserChange(MACHINE, controller.controller_id)]

    async def test_nobody_else_hears_of_it(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        subscription = harness.user_changes.subscribe(TENANT_ZERO_ID, other.id)
        async with harness.client() as client:
            await create_managed_agent(client, owner, name="scout", controller_id=None)
            await enroll_console(harness, client, owner)
        assert subscription.drain() == []
