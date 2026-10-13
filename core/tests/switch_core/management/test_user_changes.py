"""Change notices reach the owner's Console when their managed agents or
machines change, and only then."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.management.service import _status_signature
from switch_core.user_changes import (
    MACHINE,
    MANAGED_AGENT,
    LocalUserChanges,
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
