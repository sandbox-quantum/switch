"""Running a workspace's decisions on one of its admin's machines, through
the `/decision-settings` routes on real Postgres (contracts §5.3): only a
workspace admin who owns the machine may choose it, only their own machines
in this workspace are offered, and saving tells the machine at once."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.db.models import TENANT_ZERO_ID, AgentController, Tenant, TenantMember
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.decision.machine import REMOVED_REASON
from tests.switch_core.decision.machine_helpers import (
    MACHINE_NAME,
    MODEL,
    OFFER,
    FakeMachine,
    add_controller,
    hold,
    old_controller_status,
    status,
)
from tests.switch_core.gateway.test_decision_settings import (
    TENANT_B,
    _app,
    _as,
    _person,
    _row,
    _Service,
)

MACHINE = {"backend": "machine", "model": MODEL}


@pytest.fixture
def service() -> _Service:
    return _Service()


async def _machine(
    session_factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
    reported: dict | None = None,
    name: str = MACHINE_NAME,
) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
        controller = await add_controller(
            session, owner_id, name=name, reported=reported
        )
        await session.commit()
        return controller.id


async def _connected(
    session_factory: async_sessionmaker[AsyncSession], controller_id: str
) -> None:
    """The machine's socket is attached in a live process, as its row says."""
    async with session_factory() as session:
        await SwitchCoreProcessStore().renew(session, "process-a", [])
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller_id)
            .values(
                connected_at=datetime.now(UTC),
                disconnected_at=None,
                connection_process_id="process-a",
            )
        )
        await session.commit()


async def _revision(
    session_factory: async_sessionmaker[AsyncSession], controller_id: str
) -> int:
    async with session_factory() as session:
        controller = await session.get(AgentController, controller_id)
        assert controller is not None
        return controller.assignment_revision


async def test_the_owner_admin_runs_it_on_their_machine(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="admin")
    machine = await _machine(session_factory, ada.id)
    app = _app(session_factory, service, server_url=None)
    nudges: list[tuple[str, dict[str, int]]] = []
    app.state.client.use_assignment_nudges(
        lambda tenant_id, revisions: nudges.append((tenant_id, revisions))
    )
    async with _as(app, ada) as client:
        before = (await client.get("/decision-settings")).json()
        saved = await client.put(
            "/decision-settings", json={**MACHINE, "machine_id": machine}
        )

    assert before["options"]["machines"] == [
        {
            "id": machine,
            "name": MACHINE_NAME,
            "connected": False,
            "decision": {
                "supported": True,
                "hardware": {
                    "accelerator": "apple_silicon",
                    "memory_bytes": 25_769_803_776,
                },
                "offered": [OFFER],
            },
        }
    ]
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["source"] == "workspace"
    assert body["workspace"]["backend"] == "machine"
    assert body["workspace"]["machine_id"] == machine
    assert body["workspace"]["model"] == MODEL
    effective = body["effective"]
    assert effective["backend"] == "machine"
    # Not ready until the machine reports the model running for this choice:
    # unavailable, saying so, with no notices in the rooms.
    assert effective["available"] is False
    assert "is getting ready" in effective["reason"]
    assert effective["machine"]["ready"] is False
    assert effective["machine"]["id"] == machine
    assert effective["machine"]["connected"] is False
    assert "since" in effective["machine"]
    # The machine is told at once, as for a managed agent placed on it.
    assert await _revision(session_factory, machine) == 1
    assert nudges == [(TENANT_ZERO_ID, {machine: 1})]


async def test_once_ready_and_connected_it_applies(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="owner")
    machine = await _machine(session_factory, ada.id)
    await _connected(session_factory, machine)
    app = _app(session_factory, service, server_url=None)
    async with _as(app, ada) as client:
        await client.put("/decision-settings", json={**MACHINE, "machine_id": machine})
        async with session_factory() as session:
            assert await DecisionSettingsStore().mark_machine_ready(
                session, TENANT_ZERO_ID, machine, MODEL
            )
            await session.commit()
        body = (await client.get("/decision-settings")).json()

    effective = body["effective"]
    assert effective["available"] is True and effective["reason"] is None
    assert effective["machine"] == {
        "id": machine,
        "name": MACHINE_NAME,
        "model": MODEL,
        "state": "running",
        "ready": True,
        "connected": True,
        "since": "2026-10-29T09:00:00Z",
    }
    assert body["options"]["machines"][0]["connected"] is True


async def test_moving_off_the_machine_tells_it_too(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="admin")
    machine = await _machine(session_factory, ada.id)
    app = _app(session_factory, service)
    nudges: list[dict[str, int]] = []
    app.state.client.use_assignment_nudges(
        lambda _t, revisions: nudges.append(revisions)
    )
    async with _as(app, ada) as client:
        await client.put("/decision-settings", json={**MACHINE, "machine_id": machine})
        # Saving the same choice again changes nothing the machine does.
        await client.put(
            "/decision-settings",
            json={**MACHINE, "machine_id": machine, "threshold": 0.7},
        )
        await client.put("/decision-settings", json={"backend": "none"})
        await client.put("/decision-settings", json={**MACHINE, "machine_id": machine})
        await client.delete("/decision-settings")

    assert nudges == [{machine: 1}, {machine: 2}, {machine: 3}, {machine: 4}]


async def test_an_admin_who_does_not_own_the_machine_is_refused(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="member")
    bea = await _person(session_factory, "bea", role="admin")
    machine = await _machine(session_factory, ada.id)
    app = _app(session_factory, service)
    async with _as(app, bea) as client:
        listed = (await client.get("/decision-settings")).json()
        saved = await client.put(
            "/decision-settings", json={**MACHINE, "machine_id": machine}
        )
        tried = await client.post(
            "/decision-settings/test", json={**MACHINE, "machine_id": machine}
        )

    assert listed["options"]["machines"] == []
    assert saved.status_code == 422
    assert "isn't one of yours" in saved.json()["detail"]
    assert tried.status_code == 422
    assert await _row(session_factory, TENANT_ZERO_ID) is None
    assert await _revision(session_factory, machine) == 0


async def test_an_owner_who_is_not_an_admin_is_refused(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="member")
    machine = await _machine(session_factory, ada.id)
    async with _as(_app(session_factory, service), ada) as client:
        responses = [
            await client.get("/decision-settings"),
            await client.put(
                "/decision-settings", json={**MACHINE, "machine_id": machine}
            ),
            await client.post(
                "/decision-settings/test", json={**MACHINE, "machine_id": machine}
            ),
        ]

    assert [r.status_code for r in responses] == [403, 403, 403]
    assert await _row(session_factory, TENANT_ZERO_ID) is None


async def test_a_machine_in_another_workspace_is_never_offered_or_chosen(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="admin")
    # The same person, an admin of workspace B too, with a machine there.
    async with session_factory() as session:
        session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
        await session.flush()
        session.add(TenantMember(tenant_id=TENANT_B, user_id=ada.id, role="admin"))
        await session.commit()
    in_a = await _machine(session_factory, ada.id)
    in_b = await _machine(session_factory, ada.id, tenant_id=TENANT_B, name="B box")
    app = _app(session_factory, service)
    async with _as(app, ada, TENANT_B) as client:
        listed = (await client.get("/decision-settings")).json()
        saved = await client.put(
            "/decision-settings", json={**MACHINE, "machine_id": in_a}
        )

    assert [m["id"] for m in listed["options"]["machines"]] == [in_b]
    assert saved.status_code == 422
    assert await _row(session_factory, TENANT_B) is None


async def test_a_revoked_machine_is_removed_and_cannot_be_chosen(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="admin")
    machine = await _machine(session_factory, ada.id)
    app = _app(session_factory, service)
    async with _as(app, ada) as client:
        await client.put("/decision-settings", json={**MACHINE, "machine_id": machine})
        async with session_factory() as session:
            await session.execute(
                update(AgentController)
                .where(AgentController.id == machine)
                .values(revoked_at=datetime.now(UTC), api_key_id=None)
            )
            await session.commit()
        body = (await client.get("/decision-settings")).json()
        again = await client.put(
            "/decision-settings", json={**MACHINE, "machine_id": machine}
        )

    assert body["effective"]["available"] is False
    assert body["effective"]["reason"] == REMOVED_REASON
    assert body["effective"]["machine"]["state"] == "removed"
    assert body["options"]["machines"] == []
    assert again.status_code == 422
    assert "was removed" in again.json()["detail"]


async def test_a_machine_that_cannot_run_it_or_a_model_it_does_not_offer(
    session_factory: async_sessionmaker[AsyncSession], service: _Service
) -> None:
    ada = await _person(session_factory, "ada", role="admin")
    old = await _machine(
        session_factory, ada.id, reported=old_controller_status(), name="Old box"
    )
    new = await _machine(session_factory, ada.id)
    async with _as(_app(session_factory, service), ada) as client:
        listed = (await client.get("/decision-settings")).json()
        on_old = await client.put(
            "/decision-settings", json={**MACHINE, "machine_id": old}
        )
        unoffered = await client.put(
            "/decision-settings",
            json={"backend": "machine", "machine_id": new, "model": "gemma-99b"},
        )
        incomplete = await client.put(
            "/decision-settings", json={"backend": "machine", "model": MODEL}
        )

    by_id = {m["id"]: m for m in listed["options"]["machines"]}
    assert by_id[old]["decision"] == {
        "supported": False,
        "offered": [],
        "reason": "Update this machine's controller",
    }
    assert on_old.status_code == 422
    assert "update this machine's controller" in on_old.json()["detail"]
    assert unoffered.status_code == 422
    assert "doesn't offer the model 'gemma-99b'" in unoffered.json()["detail"]
    assert incomplete.status_code == 422
    assert await _row(session_factory, TENANT_ZERO_ID) is None


class TestTheTestButton:
    async def test_an_offline_machine(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        ada = await _person(session_factory, "ada", role="admin")
        machine = await _machine(session_factory, ada.id)
        async with _as(_app(session_factory, service), ada) as client:
            tried = await client.post(
                "/decision-settings/test", json={**MACHINE, "machine_id": machine}
            )

        body = tried.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "machine_offline"
        assert await _row(session_factory, TENANT_ZERO_ID) is None

    async def test_a_machine_still_downloading(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        ada = await _person(session_factory, "ada", role="admin")
        machine = await _machine(
            session_factory, ada.id, reported=status(state="downloading")
        )
        await _connected(session_factory, machine)
        async with _as(_app(session_factory, service), ada) as client:
            tried = await client.post(
                "/decision-settings/test", json={**MACHINE, "machine_id": machine}
            )

        assert tried.json()["error"]["code"] == "machine_not_ready"

    async def test_a_running_machine_answers_the_sample(
        self, session_factory: async_sessionmaker[AsyncSession], service: _Service
    ) -> None:
        ada = await _person(session_factory, "ada", role="admin")
        machine = await _machine(session_factory, ada.id)
        await _connected(session_factory, machine)
        presence = ControllerPresence(on_bound=lambda _agent_id: None)
        fake = FakeMachine(hold(presence, machine, TENANT_ZERO_ID))
        fake.pick = "deploy-bot"
        app = _app(session_factory, service, presence=presence)
        async with fake.running(), _as(app, ada) as client:
            tried = await client.post(
                "/decision-settings/test", json={**MACHINE, "machine_id": machine}
            )

        body = tried.json()
        assert body["ok"] is True, body
        assert body["agent"] == "deploy-bot"
        assert body["backend"] == "machine"
        assert body["confidence"] > 0.8
        assert isinstance(body["latency_ms"], int)
        [frame] = fake.requests
        assert frame["data"]["model"] == MODEL
        # The fixed sample, never a room's messages.
        assert (
            "deploy to staging failed"
            in frame["data"]["payload"]["messages"][1]["content"]
        )
        assert service.calls == []
