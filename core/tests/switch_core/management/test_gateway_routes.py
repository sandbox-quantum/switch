"""The owner's management routes on the gateway, end to end against Postgres.

Owner isolation (nobody sees or changes another person's controllers or
managed agents), the placement checks and their reason codes, adopting an
existing agent, partial updates, unmanaging, and revocation.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.auth import get_current_user
from switch_core.management.gateway_routes import router as gateway_router
from switch_core.management.notifier import ASSIGNMENT_CHANGED, CREDENTIAL_REVOKED
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    provider,
    report_status,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class TestOwnerIsolation:
    async def test_another_users_controllers_and_agents_are_invisible(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, ada)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, ada, name="reviewer", controller_id=controller.controller_id
            )
            agent_id = created.json()["agent_id"]
            bob_cookies = cookies_for(bob)

            controllers = await client.get(
                "/gateway/management/controllers", cookies=bob_cookies
            )
            agents = await client.get("/gateway/management/agents", cookies=bob_cookies)
            agent = await client.get(
                f"/gateway/management/agents/{agent_id}", cookies=bob_cookies
            )
            patched = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"desired_state": "stopped"},
                cookies=bob_cookies,
            )
            deleted = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=bob_cookies
            )
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=bob_cookies,
            )
            operation = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": controller.controller_id,
                    "kind": "provider.recheck",
                    "params": {"provider": "claude"},
                },
                cookies=bob_cookies,
            )
            operations = await client.get(
                "/gateway/management/operations",
                params={"controller_id": controller.controller_id},
                cookies=bob_cookies,
            )
            placed_on_ada = await create_managed_agent(
                client, bob, name="intruder", controller_id=controller.controller_id
            )
            still = await client.get(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(ada)
            )

        assert controllers.json() == []
        assert agents.json() == []
        for response in (agent, patched, deleted, revoked, operation, operations):
            assert response.status_code == 404, response.text
            assert response.json()["error"]["code"] == "not_found"
        assert placed_on_ada.status_code == 404
        assert still.status_code == 200
        assert still.json()["desired_state"] == "running"
        assert still.json()["controller_state"] == "online"

    async def test_adopting_another_users_agent_is_not_found(
        self, harness: Harness
    ) -> None:
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        async with harness.session_factory() as session:
            agent = await add_agent(session, name="adas-agent", owner_id=ada.id)
            await session.commit()
        async with harness.client() as client:
            response = await client.put(
                f"/gateway/management/agents/{agent.id}",
                json={
                    "controller_id": None,
                    "desired_state": "stopped",
                    "definition": definition(),
                },
                cookies=cookies_for(bob),
            )
        assert response.status_code == 404

    async def test_every_gateway_route_authenticates(self) -> None:
        def calls(dependant: object) -> list[object]:
            found = [dependant.call]  # type: ignore[attr-defined]
            for sub in dependant.dependencies:  # type: ignore[attr-defined]
                found.extend(calls(sub))
            return found

        routes = [r for r in gateway_router.routes if hasattr(r, "dependant")]
        assert len(routes) == 12
        for route in routes:
            assert get_current_user in calls(route.dependant), route.path  # type: ignore[attr-defined]

    async def test_without_a_cookie_the_gateway_refuses(self, harness: Harness) -> None:
        async with harness.client() as client:
            response = await client.get("/gateway/management/controllers")
        assert response.status_code == 401


class TestPlacement:
    async def _controller(self, harness: Harness, client, owner):
        return await enroll_console(harness, client, owner)

    async def test_a_controller_that_never_reported_is_offline(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await self._controller(harness, client, owner)
            response = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            agents = await client.get(
                "/gateway/management/agents", cookies=cookies_for(owner)
            )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "controller_offline"
        # Refused before registering, so nothing is left behind.
        assert agents.json() == []
        async with harness.session_factory() as session:
            assert await AgentStore().get_by_name(session, "reviewer") is None

    async def test_a_stale_controller_is_offline(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await self._controller(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            harness.clock.advance(seconds=181)
            response = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert response.json()["error"]["code"] == "controller_offline"

    async def test_a_revoked_controller_refuses(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await self._controller(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            response = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "controller_revoked"

    @pytest.mark.parametrize(
        ("providers", "code"),
        [
            ([], "provider_not_installed"),
            ([provider("codex")], "provider_not_installed"),
            ([provider("claude", installed=False)], "provider_not_installed"),
            ([provider("claude", auth="missing")], "provider_login_missing"),
            ([provider("claude", auth="expired")], "provider_login_expired"),
        ],
    )
    async def test_provider_refusals(
        self, harness: Harness, providers: list, code: str
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await self._controller(harness, client, owner)
            await report_status(client, controller, 1, providers=providers)
            response = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == code

    @pytest.mark.parametrize("auth", ["unknown", "something-new"])
    async def test_an_unknown_login_passes(self, harness: Harness, auth: str) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await self._controller(harness, client, owner)
            await report_status(
                client, controller, 1, providers=[provider("claude", auth=auth)]
            )
            response = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert response.status_code == 201, response.text

    async def test_moving_and_starting_are_checked_but_stopping_is_not(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        cookies = cookies_for(owner)
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            await report_status(client, first, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=first.controller_id
            )
            agent_id = created.json()["agent_id"]
            path = f"/gateway/management/agents/{agent_id}"

            move = await client.patch(
                path, json={"controller_id": second.controller_id}, cookies=cookies
            )
            harness.clock.advance(seconds=181)
            stop = await client.patch(
                path, json={"desired_state": "stopped"}, cookies=cookies
            )
            start = await client.patch(
                path, json={"desired_state": "running"}, cookies=cookies
            )
            unplace = await client.patch(
                path, json={"controller_id": None}, cookies=cookies
            )

        assert move.status_code == 409
        assert move.json()["error"]["code"] == "controller_offline"
        assert stop.status_code == 200, stop.text
        assert stop.json()["desired_state"] == "stopped"
        assert start.status_code == 409
        assert start.json()["error"]["code"] == "controller_offline"
        assert unplace.status_code == 200
        assert unplace.json()["controller_id"] is None
        assert unplace.json()["controller_state"] is None


class TestManagedAgents:
    async def test_create_registers_an_owner_only_known_agent(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("codex")])
            response = await create_managed_agent(
                client,
                owner,
                name="builder",
                controller_id=controller.controller_id,
                definition_body=definition("codex", directory="/srv/example"),
            )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["revision"] == 1
        assert body["definition"]["provider"] == "codex"
        async with harness.session_factory() as session:
            agent = await AgentStore().get(session, body["agent_id"])
        assert agent is not None
        assert agent.owner_id == owner.id
        assert agent.addressing_policy is not None
        assert agent.metadata_["known_agent_type"] == "codex"
        assert agent.metadata_["known_agent_options"]["auto_session"] is True
        assert agent.metadata_["known_agent_options"]["repo_dir"] == "/srv/example"

    async def test_a_name_clash_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await create_managed_agent(
                client, owner, name="reviewer", controller_id=None
            )
            second = await create_managed_agent(
                client, owner, name="reviewer", controller_id=None
            )
        assert first.status_code == 201
        assert second.status_code == 409
        assert second.json()["error"]["code"] == "validation_error"

    async def test_an_invalid_definition_is_refused(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            unknown_provider = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=None,
                definition_body=definition("gemini"),
            )
            extra_key = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=None,
                definition_body={**definition(), "skils": []},
            )
            too_long = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=None,
                definition_body=definition(instructions="x" * (32 * 1024 + 1)),
            )
        for response in (unknown_provider, extra_key, too_long):
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "validation_error"

    async def test_adopting_an_existing_agent(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.session_factory() as session:
            agent = await add_agent(session, name="existing", owner_id=owner.id)
            await session.commit()
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            adopted = await client.put(
                f"/gateway/management/agents/{agent.id}",
                json={
                    "controller_id": controller.controller_id,
                    "desired_state": "running",
                    "definition": definition(directory="/srv/existing"),
                },
                cookies=cookies_for(owner),
            )
            again = await client.put(
                f"/gateway/management/agents/{agent.id}",
                json={
                    "controller_id": controller.controller_id,
                    "desired_state": "running",
                    "definition": definition(directory="/srv/existing"),
                },
                cookies=cookies_for(owner),
            )
            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
        assert adopted.status_code == 200, adopted.text
        assert adopted.json()["revision"] == 1
        # An identical replace changes nothing and bumps nothing.
        assert again.json()["revision"] == 1
        assert assignment.json()["revision"] == 1
        [entry] = assignment.json()["agents"]
        assert entry["definition"]["directory"] == "/srv/existing"
        async with harness.session_factory() as session:
            refreshed = await AgentStore().get(session, agent.id)
        assert refreshed is not None
        assert refreshed.metadata_["known_agent_type"] == "claude-code"
        assert refreshed.integration_profile["connection_model"] == "auto_session"

    async def test_adopting_an_agent_of_another_known_type_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=None
            )
            agent_id = created.json()["agent_id"]
            response = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"definition": definition("codex")},
                cookies=cookies_for(owner),
            )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "validation_error"

    async def test_unmanaging_keeps_the_agent(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            agent_id = created.json()["agent_id"]
            deleted = await client.delete(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
            gone = await client.get(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
        assert deleted.status_code == 200
        assert gone.status_code == 404
        assert assignment.json() == {"revision": 2, "agents": []}
        async with harness.session_factory() as session:
            assert await AgentStore().get(session, agent_id) is not None

    async def test_the_view_carries_the_agents_reported_status(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            agent_id = created.json()["agent_id"]
            entry = {
                "agent_id": agent_id,
                "applied_revision": 1,
                "process": "crashed",
                "attached": False,
                "sessions": {"active": 0, "ids": []},
                "restarts_10m": 2,
                "oom_kills": 1,
                "since": "2026-01-01T00:00:00Z",
                "reason": "out_of_memory",
            }
            await report_status(
                client, controller, 2, providers=[provider("claude")], agents=[entry]
            )
            view = await client.get(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
        assert view.json()["status"] == entry
        assert view.json()["controller_state"] == "online"


class TestRevocation:
    async def test_revoking_nudges_keeps_definitions_and_refuses_the_token(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            subscription = harness.management.service.notifier.subscribe(
                controller.controller_id
            )
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            again = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
            agents = await client.get(
                "/gateway/management/agents", cookies=cookies_for(owner)
            )
            refused = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
        assert revoked.status_code == 200
        assert again.status_code == 200
        assert [event for event, _ in subscription.drain()] == [CREDENTIAL_REVOKED]
        assert listed.json()[0]["state"] == "revoked"
        assert listed.json()[0]["revoked_at"] is not None
        [agent] = agents.json()
        assert agent["agent_id"] == created.json()["agent_id"]
        assert agent["controller_state"] == "revoked"
        assert refused.status_code == 401
        assert refused.json()["error"]["code"] == "controller_revoked"

    async def test_a_change_nudges_the_controller(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            subscription = harness.management.service.notifier.subscribe(
                controller.controller_id
            )
            await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert subscription.drain() == [(ASSIGNMENT_CHANGED, {"revision": 1})]


class TestDeletingAManagedAgentThroughCore:
    async def test_the_controller_is_bumped_and_nudged(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            agent_id = created.json()["agent_id"]
            subscription = harness.management.service.notifier.subscribe(
                controller.controller_id
            )
            await harness.protocol.delete_agent(agent_id=agent_id)
            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers={**controller.headers, "If-None-Match": '"1"'},
            )
        assert subscription.drain() == [(ASSIGNMENT_CHANGED, {"revision": 2})]
        assert assignment.status_code == 200
        assert assignment.json() == {"revision": 2, "agents": []}
