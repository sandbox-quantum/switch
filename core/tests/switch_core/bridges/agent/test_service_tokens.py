"""The service-token agent routes, through the real app on Postgres.

Every request goes through the bearer middleware and the controller
authenticator as in production, so each refusal below is the one a caller
would see, in the contract's envelope. Only the vendor is faked.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.db.models import (
    TENANT_ZERO_ID,
    ServiceTokenIssuance,
    Tenant,
    TenantMember,
)
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    RESOURCES,
    STORE,
    adopt,
    agent_with_key,
    bound_to,
    build_service_harness,
    code,
    connect,
    grant_directly,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    cookies_for,
    enroll_console,
    place_agent,
)


@pytest.fixture
def vendor() -> FakeVendor:
    return FakeVendor()


@pytest.fixture
def harness(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> Harness:
    return build_service_harness(session_factory, vendor)[0]


async def _fetch(harness: Harness, agent_id: str, headers: dict[str, str]):
    async with harness.client() as client:
        return await client.post(
            f"/agents/{agent_id}/service-tokens/github", headers=headers
        )


async def _records(harness: Harness) -> list[ServiceTokenIssuance]:
    async with harness.session_factory() as session:
        return list(await session.scalars(select(ServiceTokenIssuance)))


class TestIssuing:
    async def test_an_agents_own_key_gets_a_token_and_a_record(
        self, harness: Harness, vendor: FakeVendor, caplog
    ) -> None:
        caplog.set_level(logging.DEBUG)
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)

        response = await _fetch(harness, agent_id, bearer(key))

        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        body = response.json()
        assert body["resources"] == RESOURCES
        assert body["token"] == vendor.issued[0][1]
        [record] = await _records(harness)
        assert (record.agent_id, record.principal, record.controller_id) == (
            agent_id,
            "agent_key",
            None,
        )
        assert body["token"] not in caplog.text

    async def test_a_controller_acting_as_its_agent_is_named_on_the_record(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)

        response = await _fetch(harness, agent_id, controller.headers)

        assert response.status_code == 200, response.text
        [record] = await _records(harness)
        assert (record.principal, record.controller_id) == (
            "controller",
            controller.controller_id,
        )

    async def test_the_grants_carry_their_skill(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)

        async with harness.client() as client:
            response = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )

        assert response.status_code == 200, response.text
        [grant] = response.json()["grants"]
        assert {key: grant[key] for key in ("service", "access", "tool_mode")} == {
            "service": "github",
            "access": "write",
            "tool_mode": "deny",
        }
        assert grant["resources"] == RESOURCES
        assert grant["skill"]["name"] == "github"
        assert "name: github" in grant["skill"]["content"]


class TestRefusals:
    async def test_an_agent_with_no_grant(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)

        response = await _fetch(harness, agent_id, bearer(key))

        assert code(response) == (403, "grant_missing")
        assert response.headers["cache-control"] == "no-store"

    async def test_a_grant_owned_by_someone_else(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, other.id)
        await grant_directly(harness.session_factory, agent_id, other.id)

        assert code(await _fetch(harness, agent_id, bearer(key))) == (403, "forbidden")

    async def test_an_owner_no_longer_in_the_workspace(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)
        async with harness.session_factory() as session:
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == owner.id)
            )
            await session.commit()

        assert code(await _fetch(harness, agent_id, bearer(key))) == (403, "forbidden")

    async def test_a_connection_that_needs_reauthorization(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)
        async with harness.session_factory() as session:
            await STORE.mark_needs_reauthorization(
                session, owner.id, "github", "refresh_refused"
            )
            await session.commit()

        response = await _fetch(harness, agent_id, bearer(key))
        assert code(response) == (409, "connector_revoked")
        assert "Settings, Connections" in response.json()["error"]["message"]

    async def test_another_owners_controller_bound_to_the_agent(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        other = await add_member(harness.session_factory, "bob")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)
        async with harness.client() as client:
            theirs = await enroll_console(harness, client, other)
        harness.protocol.connections.controllers.bind(
            Binding(
                agent_id=agent_id,
                controller_id=theirs.controller_id,
                tenant_id=TENANT_ZERO_ID,
                controller_name="machine",
                running=True,
            )
        )

        assert code(await _fetch(harness, agent_id, theirs.headers)) == (
            403,
            "forbidden",
        )

    async def test_a_controller_not_bound_to_the_agent(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, _ = await agent_with_key(harness.session_factory, owner, "builder")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)

        assert code(await _fetch(harness, agent_id, controller.headers)) == (
            403,
            "not_assigned",
        )

    async def test_a_controller_backed_agents_own_key(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        await adopt(harness, owner, controller, agent_id)

        assert code(await _fetch(harness, agent_id, bearer(key))) == (
            409,
            "managed_by_controller",
        )
        async with harness.client() as client:
            listed = await client.get(
                f"/agents/{agent_id}/service-grants", headers=bearer(key)
            )
        assert code(listed) == (409, "managed_by_controller")

    async def test_a_key_naming_another_tenants_agent(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        _, key = await agent_with_key(harness.session_factory, owner, "builder")
        async with harness.session_factory() as session:
            session.add(Tenant(id="tenant-b", slug="tenant-b", name="B"))
            await session.commit()
        other = await add_member(harness.session_factory, "bob", tenant_id="tenant-b")
        theirs, _ = await agent_with_key(
            bound_to(harness.session_factory, "tenant-b"), other, "theirs"
        )

        response = await _fetch(harness, theirs, bearer(key))
        assert code(response) == (403, "forbidden")
        async with harness.client() as client:
            listed = await client.get(
                f"/agents/{theirs}/service-grants", headers=bearer(key)
            )
        assert code(listed) == (403, "forbidden")


class TestAccessChanges:
    async def test_after_disconnecting_the_fetch_names_the_missing_grant(
        self, harness: Harness, vendor: FakeVendor
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)
        issued = (await _fetch(harness, agent_id, bearer(key))).json()["token"]

        async with harness.client() as client:
            removed = await client.delete(
                "/gateway/service-connections/github", cookies=cookies_for(owner)
            )
        assert removed.status_code == 200, removed.text

        response = await _fetch(harness, agent_id, bearer(key))
        assert code(response) == (403, "grant_missing")
        assert "Connections" in response.json()["error"]["message"]
        assert vendor.revoked == [issued]

    async def test_relinking_another_account_needs_a_new_grant_and_the_same_does_not(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        agent_id, key = await agent_with_key(harness.session_factory, owner, "builder")
        await connect(harness.session_factory, owner.id)
        await grant_directly(harness.session_factory, agent_id, owner.id)

        await connect(harness.session_factory, owner.id, account_id="1001")
        assert (await _fetch(harness, agent_id, bearer(key))).status_code == 200

        await connect(harness.session_factory, owner.id, account_id="2002")
        assert code(await _fetch(harness, agent_id, bearer(key))) == (
            409,
            "grant_account_changed",
        )
