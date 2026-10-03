"""Cloud machines enroll their agents controller; cloud agents are placed on it.

A machine's supervisor enrolls with the machine capability (proof
`machine_secret`) and gets a controller of kind `ec2` bound to the machine;
enrolling again replaces it. Each cloud launch with an agent is mirrored as a
managed agent placed on that controller, rebuilt only when the launch moves
to a new revision, and the supervisor's own agent list stops carrying the
agent's key once it is.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    AgentDefinition,
    HostedMachine,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    bearer,
    build_harness,
    cookies_for,
    definition,
    enroll_console,
    fixture,
    provider,
    report_status,
)
from tests.switch_core.management.hosted_harness import (
    add_cloud_agent,
    add_cloud_machine,
    assignment,
    build_hosted_harness,
    enroll_machine,
    enrolled_token,
    fixture_heartbeat,
    host_headers,
    launch_row,
    update_launch,
)


@pytest.fixture
def harness(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> Harness:
    return build_hosted_harness(session_factory, tmp_path)


async def _controllers(harness: Harness, machine_id: str) -> list[AgentController]:
    async with harness.session_factory() as session:
        return list(
            (
                await session.scalars(
                    select(AgentController)
                    .where(AgentController.hosted_machine_id == machine_id)
                    .order_by(AgentController.created_at)
                )
            ).all()
        )


async def _definition(harness: Harness, agent_id: str) -> AgentDefinition | None:
    async with harness.session_factory() as session:
        return await session.scalar(
            select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
        )


class TestMachineSecretEnrollment:
    async def test_the_machine_capability_enrolls_an_ec2_controller(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        async with harness.client() as client:
            enrolled = await enroll_machine(client, machine)
            assert enrolled.status_code == 201, enrolled.text
            body = enrolled.json()
            assert body["credential"].startswith("swcc_")
            token = await client.post(
                f"/v1/management/controllers/{body['controller_id']}/token",
                json={"credential": body["credential"]},
            )
        assert token.status_code == 200, token.text
        [controller] = await _controllers(harness, machine.machine_id)
        assert controller.id == body["controller_id"]
        assert controller.kind == "ec2"
        assert controller.owner_id == machine.owner.id
        assert controller.revoked_at is None

    @pytest.mark.parametrize(
        ("change", "status", "code"),
        [
            ({"capability": "wrong-capability-0123456789"}, 401, "invalid_credential"),
            ({"headers": {}}, 400, "validation_error"),
            ({"kind": "daemon"}, 422, "validation_error"),
        ],
    )
    async def test_a_bad_proof_is_refused(
        self, harness: Harness, change: dict, status: int, code: str
    ) -> None:
        machine = await add_cloud_machine(harness)
        async with harness.client() as client:
            refused = await enroll_machine(client, machine, **change)
        assert refused.status_code == status, refused.text
        assert refused.json()["error"]["code"] == code
        assert await _controllers(harness, machine.machine_id) == []

    async def test_a_retired_machine_is_refused(self, harness: Harness) -> None:
        machine = await add_cloud_machine(harness)
        async with harness.session_factory() as session:
            row = await session.get(HostedMachine, (TENANT_ZERO_ID, machine.machine_id))
            assert row is not None
            row.desired_state = "retained"
            row.state = "retained"
            await session.commit()
        async with harness.client() as client:
            refused = await enroll_machine(client, machine)
        assert refused.status_code == 410
        assert refused.json()["error"]["code"] == "machine_retired"

    async def test_a_server_without_cloud_machines_refuses(
        self, session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
    ) -> None:
        hosted = build_hosted_harness(session_factory, tmp_path)
        machine = await add_cloud_machine(hosted)
        # Management's dependencies are process-wide: the harness built last
        # is the one serving, and this one names no cloud machines file.
        plain = build_harness(session_factory)
        async with plain.client() as client:
            refused = await enroll_machine(client, machine)
        assert refused.status_code == 401
        assert refused.json()["error"]["code"] == "invalid_credential"

    async def test_an_enrollment_code_cannot_enroll_an_ec2_controller(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            code = (
                await client.post(
                    "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
                )
            ).json()["code"]
            body = fixture("enroll_request.json")
            body["proof"]["code"] = code
            body["controller"]["kind"] = "ec2"
            refused = await client.post("/v1/management/controllers/enroll", json=body)
        assert refused.status_code == 422
        assert refused.json()["error"]["code"] == "validation_error"

    async def test_enrolling_again_keeps_the_controller_with_a_new_credential(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            first = (await enroll_machine(client, machine)).json()
            before = await _definition(harness, agent.agent_id)
            second = (await enroll_machine(client, machine)).json()
            stale = await client.post(
                f"/v1/management/controllers/{first['controller_id']}/token",
                json={"credential": first["credential"]},
            )
            fresh = await client.post(
                f"/v1/management/controllers/{second['controller_id']}/token",
                json={"credential": second["credential"]},
            )
        assert second["controller_id"] == first["controller_id"]
        assert second["credential"] != first["credential"]
        assert stale.status_code == 401
        assert stale.json()["error"]["code"] == "invalid_credential"
        assert fresh.status_code == 200, fresh.text
        [controller] = await _controllers(harness, machine.machine_id)
        assert controller.revoked_at is None
        after = await _definition(harness, agent.agent_id)
        assert before is not None and after is not None
        assert after.controller_id == controller.id
        assert after.revision == before.revision

    async def test_a_revoked_machine_controller_is_replaced_by_a_new_one(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            first = (await enroll_machine(client, machine)).json()
            revoked = await client.delete(
                f"/gateway/management/controllers/{first['controller_id']}",
                cookies=cookies_for(machine.owner),
            )
            assert revoked.status_code == 200, revoked.text
            second = (await enroll_machine(client, machine)).json()
        assert second["controller_id"] != first["controller_id"]
        old, new = await _controllers(harness, machine.machine_id)
        assert old.id == first["controller_id"] and old.revoked_at is not None
        assert new.id == second["controller_id"] and new.revoked_at is None
        row = await _definition(harness, agent.agent_id)
        assert row is not None and row.controller_id == new.id
        binding = harness.protocol.connections.controllers.binding(agent.agent_id)
        assert binding is not None and binding.controller_id == new.id


class TestCloudAgentsArePlaced:
    async def test_enrollment_places_the_machine_cloud_agents(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            controller_id, token = await enrolled_token(client, machine)
            body = await assignment(client, controller_id, token)
        [entry] = body["agents"]
        assert entry["agent_id"] == agent.agent_id
        assert entry["desired_state"] == "running"
        definition_body = entry["definition"]
        assert definition_body["provider"] == "claude"
        assert definition_body["model"] == "sonnet"
        assert definition_body["instructions"] == "Help with the repository."
        hosted = definition_body["hosted"]
        launch = await launch_row(harness, agent.launch_id)
        assert hosted["machine_id"] == machine.machine_id
        assert hosted["launch_id"] == agent.launch_id
        assert hosted["launch_revision"] == 1
        assert hosted["provider_credential_kind"] == "setup-token"
        assert hosted["repository"] == "example/project"
        assert hosted["spec"]["definition"].startswith("---")
        assert hosted["skills"] and hosted["skills"][0]["slug"] == "github"
        assert HostedLaunchStore.capability_matches(launch, hosted["worker_capability"])
        assert launch.state == "provisioning"
        assert harness.protocol.connections.controllers.is_bound(agent.agent_id)

    async def test_the_stored_definition_holds_no_capability(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            await enrolled_token(client, machine)
        row = await _definition(harness, agent.agent_id)
        assert row is not None
        assert "worker_capability" not in row.definition["hosted"]

    async def test_a_new_launch_revision_rebuilds_the_definition(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            controller_id, token = await enrolled_token(client, machine)
            before = await assignment(client, controller_id, token)
            await update_launch(
                harness,
                agent.launch_id,
                revision=2,
                desired_state="stopped",
                state="stopping",
                spec={
                    **(await launch_row(harness, agent.launch_id)).spec,
                    "instructions": "New instructions.",
                },
            )
            await harness.management.service.hosted.sync(
                TENANT_ZERO_ID, machine.machine_id
            )
            after = await assignment(client, controller_id, token)
        assert after["revision"] > before["revision"]
        [old_entry], [new_entry] = before["agents"], after["agents"]
        assert new_entry["revision"] == old_entry["revision"] + 1
        assert new_entry["desired_state"] == "stopped"
        assert new_entry["definition"]["instructions"] == "New instructions."
        assert new_entry["definition"]["hosted"]["launch_revision"] == 2
        assert (
            new_entry["definition"]["hosted"]["worker_capability"]
            != old_entry["definition"]["hosted"]["worker_capability"]
        )

    async def test_an_edit_without_a_new_revision_changes_nothing(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            controller_id, token = await enrolled_token(client, machine)
            before = await assignment(client, controller_id, token)
            await update_launch(
                harness,
                agent.launch_id,
                spec={
                    **(await launch_row(harness, agent.launch_id)).spec,
                    "instructions": "Applies at the next start.",
                },
            )
            await harness.management.service.hosted.sync(
                TENANT_ZERO_ID, machine.machine_id
            )
            after = await assignment(client, controller_id, token)
        assert after == before

    async def test_a_launch_that_moved_on_hands_out_no_stale_capability(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            controller_id, token = await enrolled_token(client, machine)
            await update_launch(harness, agent.launch_id, revision=2)
            body = await assignment(client, controller_id, token)
        assert body["agents"][0]["definition"]["hosted"]["worker_capability"] is None

    async def test_a_removed_launch_is_unmanaged(self, harness: Harness) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        async with harness.client() as client:
            controller_id, token = await enrolled_token(client, machine)
            await update_launch(
                harness, agent.launch_id, desired_state="deleted", state="deleting"
            )
            await harness.management.service.hosted.sync(
                TENANT_ZERO_ID, machine.machine_id
            )
            body = await assignment(client, controller_id, token)
        assert body["agents"] == []
        assert await _definition(harness, agent.agent_id) is None
        assert not harness.protocol.connections.controllers.is_bound(agent.agent_id)

    async def test_a_machine_without_a_controller_leaves_its_agents_unplaced(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        await harness.management.service.hosted.sync(TENANT_ZERO_ID, machine.machine_id)
        row = await _definition(harness, agent.agent_id)
        assert row is not None and row.controller_id is None
        assert not harness.protocol.connections.controllers.is_bound(agent.agent_id)
        assert (await launch_row(harness, agent.launch_id)).state == "queued"

    async def test_a_heartbeat_at_a_new_agents_version_syncs(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        async with harness.client() as client:
            await enrolled_token(client, machine)
            agent = await add_cloud_agent(harness, machine)
            async with harness.session_factory() as session:
                row = await session.get(
                    HostedMachine, (TENANT_ZERO_ID, machine.machine_id)
                )
                assert row is not None
                row.agents_version += 1
                await session.commit()
            beat = await client.post(
                f"/hosted/machines/{machine.machine_id}/heartbeat",
                json={**fixture_heartbeat(), "agents": []},
                headers={**host_headers(), **bearer(machine.capability)},
            )
        assert beat.status_code == 200, beat.text
        assert harness.protocol.connections.controllers.is_bound(agent.agent_id)


class TestTheSupervisorListStopsCarryingTheKey:
    async def test_a_placed_agent_is_listed_without_its_credential(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        headers = {**host_headers(), **bearer(machine.capability)}
        async with harness.client() as client:
            before = await client.get(
                f"/hosted/machines/{machine.machine_id}/agents", headers=headers
            )
            await enrolled_token(client, machine)
            after = await client.get(
                f"/hosted/machines/{machine.machine_id}/agents", headers=headers
            )
        assert before.status_code == 200, before.text
        assert "switch_credentials" in before.json()["agents"][0]
        [entry] = after.json()["agents"]
        assert entry == {
            "launch_id": agent.launch_id,
            "agent_id": agent.agent_id,
            "name": "cloud-helper",
            "revision": 1,
            "desired_state": "running",
            "unavailable": "managed_by_controller",
        }
        assert (await launch_row(harness, agent.launch_id)).state != "error"


class TestOwnersManageCloudAgentsThroughTheirLaunch:
    async def test_management_changes_to_a_cloud_agent_are_refused(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        agent = await add_cloud_agent(harness, machine)
        cookies = cookies_for(machine.owner)
        async with harness.client() as client:
            controller_id, _token = await enrolled_token(client, machine)
            patched = await client.patch(
                f"/gateway/management/agents/{agent.agent_id}",
                json={"desired_state": "stopped"},
                cookies=cookies,
            )
            put = await client.put(
                f"/gateway/management/agents/{agent.agent_id}",
                json={
                    "controller_id": controller_id,
                    "desired_state": "running",
                    "definition": definition(),
                },
                cookies=cookies,
            )
            deleted = await client.delete(
                f"/gateway/management/agents/{agent.agent_id}", cookies=cookies
            )
        for response in (patched, put, deleted):
            assert response.status_code == 409, response.text
            assert response.json()["error"]["code"] == "cloud_agent"

    async def test_a_local_agent_cannot_be_placed_on_a_machine_controller(
        self, harness: Harness
    ) -> None:
        machine = await add_cloud_machine(harness)
        async with harness.client() as client:
            controller_id, _token = await enrolled_token(client, machine)
            created = await client.post(
                "/gateway/management/agents",
                json={
                    "name": "local-one",
                    "description": "local",
                    "controller_id": controller_id,
                    "desired_state": "running",
                    "definition": definition(),
                },
                cookies=cookies_for(machine.owner),
            )
        assert created.status_code == 409, created.text
        assert created.json()["error"]["code"] == "cloud_agent"

    async def test_a_console_controller_still_takes_local_agents(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            console = await enroll_console(harness, client, owner)
            await report_status(client, console, 1, providers=[provider("claude")])
            created = await client.post(
                "/gateway/management/agents",
                json={
                    "name": "local-one",
                    "description": "local",
                    "controller_id": console.controller_id,
                    "desired_state": "running",
                    "definition": definition(),
                },
                cookies=cookies_for(owner),
            )
        assert created.status_code == 201, created.text
