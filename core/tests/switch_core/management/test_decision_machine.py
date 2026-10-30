"""A workspace's decision model on one of its admin's machines, from the
controller's side and the agent's (contracts §5.2, §5.4): the status report
carries the `decision` block, the assignment names the model once the machine
is chosen, the first report of it running makes the choice ready, and an
agent can choose the machine for its owner when that owner administers the
workspace and owns the machine. Through the real routes, against Postgres.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import agent_management
from switch_core.bridges.agent.operations import context as op_context
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.machine import MachineDecisions
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.management.service import _status_signature
from switch_core.outbound import OutboundPolicy
from tests.switch_core.decision.machine_helpers import MODEL, OFFER
from tests.switch_core.management.harness import (
    TEST_KEYRING,
    EnrolledController,
    Harness,
    add_member,
    bearer,
    build_harness,
    enroll_console,
    fixture,
    report_status,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Iterator[Harness]:
    harness = build_harness(session_factory)
    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    decisions = DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability(
            enabled=True,
            server=ServerDefault(
                endpoint_url=None, api_key=None, bedrock_enabled=False
            ),
            store=DecisionSettingsStore(),
            controllers=AgentControllerStore(),
        ),
        keyring=TEST_KEYRING,
        client=httpx.AsyncClient(),
        guarded_client=httpx.AsyncClient(),
        outbound_policy=OutboundPolicy.parse(""),
        timeout_seconds=1.0,
        telemetry=None,
        cache_seconds=0,
        machines=MachineDecisions(harness.protocol.connections.controllers),
    )
    decisions.use_assignment_nudges(harness.management.service.nudge_assignments)
    agent_management.use_decision_routing(decisions)
    try:
        yield harness
    finally:
        op_context._protocol = previous
        agent_management._decisions = None


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    async with harness.client() as client:
        yield client


async def _admin(harness: Harness, name: str) -> User:
    user = await add_member(harness.session_factory, name)
    async with harness.session_factory() as session:
        await session.execute(
            update(TenantMember)
            .where(TenantMember.user_id == user.id)
            .values(role="admin")
        )
        await session.commit()
    return user


async def _agent(
    harness: Harness, owner: User, name: str, *, can_manage: bool = True
) -> tuple[str, dict[str, str]]:
    key = secrets.token_urlsafe(32)
    async with harness.session_factory() as session:
        client = Client(
            type="agent", transport_user_id=f"@{name}:test", display_name=name
        )
        api_key = ApiKey(
            type="agent",
            key_hash=hashlib.sha256(key.encode()).hexdigest(),
            encrypted_key="",
            label=name,
            user_id=owner.id,
        )
        session.add_all([client, api_key])
        await session.flush()
        agent = Agent(
            name=name,
            description=f"{name} desc",
            agent_type="auto_session",
            connector_type="claude_code",
            integration_profile={"connection_model": "auto_session"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=owner.id,
            can_manage_agents=can_manage,
        )
        session.add(agent)
        await session.commit()
        return agent.id, bearer(key)


async def _call(
    client: httpx.AsyncClient,
    agent_id: str,
    operation: str,
    headers: dict[str, str],
    body: dict[str, Any] | None = None,
) -> httpx.Response:
    return await client.post(
        f"/agents/{agent_id}/ops/{operation}", json=body or {}, headers=headers
    )


def _decision(state: str, **extra: Any) -> dict[str, Any]:
    block = fixture("status_request.json")["decision"]
    return {**block, "state": state, **extra}


async def _report(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    seq: int,
    decision: dict[str, Any],
) -> httpx.Response:
    report = fixture("status_request.json")
    report["seq"] = seq
    report["decision"] = decision
    return await client.put(
        f"/v1/management/controllers/{controller.controller_id}/status",
        json=report,
        headers=controller.headers,
    )


async def _assignment(
    client: httpx.AsyncClient, controller: EnrolledController
) -> dict[str, Any]:
    response = await client.get(
        f"/v1/management/controllers/{controller.controller_id}/assignment",
        headers=controller.headers,
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


class TestTheControllersSide:
    async def test_the_assignment_names_the_model_and_running_makes_it_ready(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        mac = await enroll_console(harness, client, ada, name="Studio Mac")
        assert (await report_status(client, mac, 1)).status_code == 200
        agent_id, headers = await _agent(harness, ada, "helper")

        before = await _assignment(client, mac)
        chosen = await _call(
            client,
            agent_id,
            "set_decision_routing",
            headers,
            {"choice": "machine", "machine": "Studio Mac"},
        )
        after = await _assignment(client, mac)
        downloading = await _report(
            client,
            mac,
            2,
            _decision(
                "downloading", progress={"done_bytes": 5, "total_bytes": 2_740_000_000}
            ),
        )
        not_yet = await _call(client, agent_id, "get_decision_routing", headers)
        running = await _report(client, mac, 3, _decision("running"))
        ready = await _call(client, agent_id, "get_decision_routing", headers)

        assert before["decision"] is None
        assert chosen.status_code == 200, chosen.text
        assert after["decision"] == {"revision": after["revision"], "model": MODEL}
        assert after["revision"] == before["revision"] + 1
        assert downloading.status_code == 200, downloading.text
        effective = not_yet.json()["result"]["effective"]
        assert effective["available"] is False
        assert effective["machine"]["state"] == "downloading"
        assert effective["machine"]["progress"] == {
            "done_bytes": 5,
            "total_bytes": 2_740_000_000,
        }
        assert running.status_code == 200
        effective = ready.json()["result"]["effective"]
        assert effective["available"] is True
        assert effective["machine"]["ready"] is True
        assert effective["machine"]["connected"] is True

    async def test_a_model_running_with_nothing_chosen_makes_nothing_ready(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        mac = await enroll_console(harness, client, ada)
        await report_status(client, mac, 1)

        response = await _report(client, mac, 2, _decision("running"))

        assert response.status_code == 200
        async with harness.session_factory() as session:
            assert await DecisionSettingsStore().get(session, TENANT_ZERO_ID) is None

    async def test_a_decision_block_that_is_not_the_contracts_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        mac = await enroll_console(harness, client, ada)

        response = await _report(
            client, mac, 1, _decision("running", hardware={"accelerator": "tpu"})
        )

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"

    def test_a_downloads_progress_alone_is_not_a_change_to_show(self) -> None:
        report = fixture("status_request.json")
        further = {
            **report,
            "decision": {
                **report["decision"],
                "progress": {"done_bytes": 2_000_000_000, "total_bytes": 2_740_000_000},
            },
        }
        started = {**report, "decision": {**report["decision"], "state": "starting"}}

        assert _status_signature(further) == _status_signature(report)
        assert _status_signature(started) != _status_signature(report)


class TestTheAgentsSide:
    async def test_list_machines_says_which_can_run_the_model(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        mac = await enroll_console(harness, client, ada, name="Studio Mac")
        await enroll_console(harness, client, ada, name="Old box")
        await report_status(client, mac, 1)
        agent_id, headers = await _agent(harness, ada, "helper")

        response = await _call(client, agent_id, "list_machines", headers)

        machines = {m["name"]: m for m in response.json()["result"]}
        assert machines["Studio Mac"]["decision"] == {
            "supported": True,
            "offered": [
                {"model": MODEL, "label": OFFER["label"], "speed": OFFER["speed"]}
            ],
            "state": "downloading",
            "model": MODEL,
        }
        assert machines["Old box"]["decision"] == {"supported": False}

    async def test_an_owner_who_is_not_a_workspace_admin_is_refused_with_why(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        grace = await add_member(harness.session_factory, "grace")
        mac = await enroll_console(harness, client, grace, name="Grace's Mac")
        await report_status(client, mac, 1)
        agent_id, headers = await _agent(harness, grace, "helper")

        shown = await _call(client, agent_id, "get_decision_routing", headers)
        chosen = await _call(
            client,
            agent_id,
            "set_decision_routing",
            headers,
            {"choice": "machine", "machine": mac.controller_id},
        )

        for refused in (shown, chosen):
            assert refused.status_code == 403, refused.text
            assert "only a workspace admin can choose" in refused.json()["detail"]
        async with harness.session_factory() as session:
            assert await DecisionSettingsStore().get(session, TENANT_ZERO_ID) is None

    async def test_without_the_capability_it_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        agent_id, headers = await _agent(harness, ada, "helper", can_manage=False)

        response = await _call(client, agent_id, "get_decision_routing", headers)

        assert response.status_code == 403
        assert "can manage agents" in response.json()["detail"]

    async def test_another_persons_machine_reads_as_missing(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        grace = await add_member(harness.session_factory, "grace")
        theirs = await enroll_console(harness, client, grace, name="Grace's Mac")
        await report_status(client, theirs, 1)
        agent_id, headers = await _agent(harness, ada, "helper")

        response = await _call(
            client,
            agent_id,
            "set_decision_routing",
            headers,
            {"choice": "machine", "machine": theirs.controller_id},
        )
        shown = await _call(client, agent_id, "get_decision_routing", headers)

        assert response.status_code == 400, response.text
        assert "has no machine with the id or name" in response.json()["detail"]
        assert shown.json()["result"]["options"]["machines"] == []

    async def test_back_to_the_server_default_tells_the_machine(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        mac = await enroll_console(harness, client, ada, name="Studio Mac")
        await report_status(client, mac, 1)
        agent_id, headers = await _agent(harness, ada, "helper")
        await _call(
            client,
            agent_id,
            "set_decision_routing",
            headers,
            {"choice": "machine", "machine": mac.controller_id, "model": MODEL},
        )
        chosen = await _assignment(client, mac)

        response = await _call(
            client,
            agent_id,
            "set_decision_routing",
            headers,
            {"choice": "server_default"},
        )
        after = await _assignment(client, mac)

        assert response.status_code == 200, response.text
        assert response.json()["result"]["source"] == "server_default"
        assert after["decision"] is None
        assert after["revision"] == chosen["revision"] + 1

    async def test_a_model_the_machine_does_not_offer_is_refused(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> None:
        ada = await _admin(harness, "ada")
        mac = await enroll_console(harness, client, ada, name="Studio Mac")
        await report_status(client, mac, 1)
        agent_id, headers = await _agent(harness, ada, "helper")

        response = await _call(
            client,
            agent_id,
            "set_decision_routing",
            headers,
            {"choice": "machine", "machine": "Studio Mac", "model": "gemma-99b"},
        )

        assert response.status_code == 400
        assert "doesn't offer the model 'gemma-99b'" in response.json()["detail"]
