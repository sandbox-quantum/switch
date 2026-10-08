"""The owner's management routes on the gateway, end to end against Postgres.

Owner isolation (nobody sees or changes another person's controllers or
managed agents), the placement checks and their reason codes, adopting an
existing agent, partial updates, unmanaging, and revocation.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_icon import generated_icon_url
from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.auth import get_current_user
from switch_core.management.gateway_routes import router as gateway_router
from switch_core.management.notifier import ASSIGNMENT_CHANGED, CREDENTIAL_REVOKED
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.management.harness import (
    WORKSPACES_DIR,
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    platform,
    provider,
    report_status,
    status_report,
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
        assert len(routes) == 14
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

    async def test_create_gives_the_generated_icon_unless_one_is_chosen(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            generated = await create_managed_agent(
                client, owner, name="scout", controller_id=None
            )
            chosen = await client.post(
                "/gateway/management/agents",
                json={
                    "name": "painter",
                    "description": "Paints",
                    "icon_url": "https://example.com/painter.png",
                    "controller_id": None,
                    "desired_state": "stopped",
                    "definition": definition(),
                },
                cookies=cookies_for(owner),
            )
            unsafe = await client.post(
                "/gateway/management/agents",
                json={
                    "name": "prober",
                    "description": "Probes",
                    "icon_url": "http://10.0.0.1/icon.png",
                    "controller_id": None,
                    "desired_state": "stopped",
                    "definition": definition(),
                },
                cookies=cookies_for(owner),
            )
        assert generated.status_code == 201, generated.text
        assert chosen.status_code == 201, chosen.text
        assert unsafe.status_code == 422
        async with harness.session_factory() as session:
            scout = await AgentStore().get(session, generated.json()["agent_id"])
            painter = await AgentStore().get(session, chosen.json()["agent_id"])
            prober = await AgentStore().get_by_name(session, "prober")
        assert scout is not None and scout.icon_url == generated_icon_url("scout")
        assert painter is not None
        assert painter.icon_url == "https://example.com/painter.png"
        assert prober is None

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

    async def test_advanced_config_is_held_to_the_providers_schema(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            created = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=None,
                definition_body=definition(
                    advanced_config={"effort": "high", "tools": ["Read"]}
                ),
            )
            agent_id = created.json()["agent_id"]
            refused = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"definition": definition(advanced_config={"effort": "huge"})},
                cookies=cookies_for(owner),
            )
            view = await client.get(
                f"/gateway/management/agents/{agent_id}", cookies=cookies_for(owner)
            )
            cleared = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"definition": definition()},
                cookies=cookies_for(owner),
            )
        assert created.status_code == 201, created.text
        assert created.json()["definition"]["advanced_config"] == {
            "effort": "high",
            "tools": ["Read"],
        }
        assert refused.status_code == 422
        error = refused.json()["error"]
        assert error["code"] == "validation_error"
        assert "claude setting 'effort' must be one of" in error["message"]
        assert view.json()["definition"]["advanced_config"] == {
            "effort": "high",
            "tools": ["Read"],
        }
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["definition"]["advanced_config"] == {}
        assert cleared.json()["revision"] == 2

    async def test_the_advanced_config_schema_is_served(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            served = await client.get(
                "/gateway/management/advanced-config", cookies=cookies_for(owner)
            )
            anonymous = await client.get("/gateway/management/advanced-config")
        assert served.status_code == 200, served.text
        providers = served.json()["providers"]
        assert set(providers) == {
            "claude",
            "codex",
            "opencode",
            "cursor",
            "antigravity",
        }
        assert providers["cursor"] == {"fields": []}
        effort = next(
            field for field in providers["claude"]["fields"] if field["key"] == "effort"
        )
        assert effort["options"][0] == {"value": "", "label": "Inherit"}
        assert anonymous.status_code == 401

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
        assert view.json()["status"] == {**entry, "directory": None}
        assert view.json()["controller_state"] == "online"


async def report_machine(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    seq: int,
    *,
    workspaces_dir: str | None,
) -> None:
    """A status report naming `workspaces_dir`, or one from a controller
    that predates the field when it is None."""
    report = status_report(seq, providers=[provider("claude")], agents=[])
    if workspaces_dir is None:
        del report["machine"]["workspaces_dir"]
    else:
        report["machine"]["workspaces_dir"] = workspaces_dir
    response = await client.put(
        f"/v1/management/controllers/{controller.controller_id}/status",
        json=report,
        headers=controller.headers,
    )
    assert response.status_code == 200, response.text


class TestTheWorkingDirectory:
    async def test_create_names_the_machines_workspace_for_the_agent(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            chosen = await create_managed_agent(
                client,
                owner,
                name="writer",
                controller_id=controller.controller_id,
                definition_body=definition(directory="/srv/writer"),
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
        assert created.status_code == 201, created.text
        assert created.json()["definition"]["directory"] == f"{WORKSPACES_DIR}/reviewer"
        assert chosen.json()["definition"]["directory"] == "/srv/writer"
        assert listed.json()[0]["workspaces_dir"] == WORKSPACES_DIR
        directories = {
            entry["definition"]["name"]: entry["definition"]["directory"]
            for entry in assignment.json()["agents"]
        }
        assert directories == {
            "reviewer": f"{WORKSPACES_DIR}/reviewer",
            "writer": "/srv/writer",
        }

    async def test_an_update_or_a_move_names_the_target_machines_workspace(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        cookies = cookies_for(owner)
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            await report_machine(client, first, 1, workspaces_dir="/one/workspaces")
            await report_machine(client, second, 1, workspaces_dir="/two/workspaces")
            created = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=first.controller_id,
                definition_body=definition(directory="/srv/reviewer"),
            )
            path = f"/gateway/management/agents/{created.json()['agent_id']}"
            cleared = await client.patch(
                path, json={"definition": definition(directory=None)}, cookies=cookies
            )
            moved = await client.patch(
                path, json={"controller_id": second.controller_id}, cookies=cookies
            )
            kept = await client.put(
                path,
                json={
                    "controller_id": first.controller_id,
                    "desired_state": "running",
                    "definition": definition(directory="/srv/kept"),
                },
                cookies=cookies,
            )
        assert created.json()["definition"]["directory"] == "/srv/reviewer"
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["definition"]["directory"] == "/one/workspaces/reviewer"
        assert moved.status_code == 200, moved.text
        assert moved.json()["definition"]["directory"] == "/two/workspaces/reviewer"
        assert kept.json()["definition"]["directory"] == "/srv/kept"

    async def test_a_controller_that_has_not_said_leaves_it_null(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_machine(client, controller, 1, workspaces_dir=None)
            created = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
            unplaced = await create_managed_agent(
                client, owner, name="spare", controller_id=None
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert created.status_code == 201, created.text
        assert created.json()["definition"]["directory"] is None
        assert unplaced.json()["definition"]["directory"] is None
        assert listed.json()[0]["workspaces_dir"] is None

    async def test_the_status_carries_where_the_agent_runs(
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
            await report_status(
                client,
                controller,
                2,
                providers=[provider("claude")],
                agents=[
                    {
                        "agent_id": agent_id,
                        "applied_revision": 1,
                        "process": "running",
                        "attached": True,
                        "sessions": {"active": 0, "ids": []},
                        "restarts_10m": 0,
                        "oom_kills": 0,
                        "directory": f"{WORKSPACES_DIR}/reviewer",
                        "since": "2026-01-01T00:00:00Z",
                    }
                ],
            )
            listed = await client.get(
                "/gateway/management/agents", cookies=cookies_for(owner)
            )
        [view] = listed.json()
        assert view["status"]["directory"] == f"{WORKSPACES_DIR}/reviewer"


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


class TestMachineNameAndDescription:
    async def test_console_enrollment_takes_an_optional_description(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            described = await client.post(
                "/gateway/management/controllers",
                json={
                    "name": "  laptop  ",
                    "description": "  My work laptop ",
                    "kind": "console",
                    "platform": platform(),
                    "version": "0.1.0",
                },
                cookies=cookies_for(owner),
            )
            await enroll_console(harness, client, owner, name="desktop")
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert described.status_code == 201, described.text
        by_name = {c["name"]: c for c in listed.json()}
        assert by_name["laptop"]["description"] == "My work laptop"
        assert by_name["desktop"]["description"] is None

    async def test_the_owner_renames_and_describes_a_machine(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner, name="laptop")
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=controller.controller_id,
            )
            agent_id = created.json()["agent_id"]
            path = f"/gateway/management/controllers/{controller.controller_id}"
            renamed = await client.patch(
                path,
                json={"name": " build box ", "description": "Under the desk"},
                cookies=cookies_for(owner),
            )
            name_only = await client.patch(
                path, json={"name": "build-box"}, cookies=cookies_for(owner)
            )
            cleared = await client.patch(
                path, json={"description": None}, cookies=cookies_for(owner)
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )

        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["name"] == "build box"
        assert renamed.json()["description"] == "Under the desk"
        assert renamed.json()["state"] == "online"
        assert name_only.json()["description"] == "Under the desk"
        assert cleared.json()["name"] == "build-box"
        assert cleared.json()["description"] is None
        [stored] = listed.json()
        assert (stored["name"], stored["description"]) == ("build-box", None)
        binding = harness.protocol.connections.controllers.binding(agent_id)
        assert binding is not None
        assert binding.controller_name == "build-box"

    async def test_another_users_machine_is_not_found(self, harness: Harness) -> None:
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, ada, name="laptop")
            response = await client.patch(
                f"/gateway/management/controllers/{controller.controller_id}",
                json={"name": "mine now"},
                cookies=cookies_for(bob),
            )
            missing = await client.patch(
                "/gateway/management/controllers/no-such-controller",
                json={"name": "mine now"},
                cookies=cookies_for(bob),
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(ada)
            )
        assert response.status_code == 404
        assert response.json() == missing.json()
        assert listed.json()[0]["name"] == "laptop"

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"name": ""},
            {"name": "   "},
            {"name": None},
            {"name": "x" * 201},
            {"description": "x" * 501},
            {"platform": "linux"},
        ],
    )
    async def test_an_invalid_change_is_refused(
        self, harness: Harness, body: dict
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner, name="laptop")
            response = await client.patch(
                f"/gateway/management/controllers/{controller.controller_id}",
                json=body,
                cookies=cookies_for(owner),
            )
            listed = await client.get(
                "/gateway/management/controllers", cookies=cookies_for(owner)
            )
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "validation_error"
        assert listed.json()[0]["name"] == "laptop"
