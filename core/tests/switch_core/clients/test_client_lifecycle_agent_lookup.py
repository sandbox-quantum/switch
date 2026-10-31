"""An agent's actor is found without scanning every client's actor each time,
and a lookup still finds the actor running now after it was replaced."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from switch_core.clients.actor import AgentActor
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from tests.ownership import NeverOwned


class _CountingScans(dict[str, Any]):
    scans = 0

    def items(self):  # type: ignore[no-untyped-def,override]
        self.scans += 1
        return super().items()


def _actor(agent_id: str) -> AgentActor:
    actor = AgentActor.__new__(AgentActor)
    actor._agent = SimpleNamespace(id=agent_id)  # type: ignore[assignment]
    return actor


def _service(clients: dict[str, Any]) -> ClientLifecycleService:
    service = ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=MagicMock(),
        tenant_store=MagicMock(),
        client_factory=MagicMock(),
        session_factory=MagicMock(),
        config=MagicMock(),
        tenants_isolated=True,
        ownership=NeverOwned(),  # type: ignore[arg-type]
        cursor_writer=MagicMock(),
    )
    service._clients = clients
    return service


def test_an_agent_found_once_is_found_again_without_a_scan() -> None:
    clients = _CountingScans({f"client-{n}": _actor(f"agent-{n}") for n in range(1000)})
    service = _service(clients)

    first = service.get_by_agent_id("agent-500")
    again = service.get_by_agent_id("agent-500")

    assert first is clients["client-500"]
    assert again is first
    assert clients.scans == 1


def test_a_replaced_actor_is_the_one_found() -> None:
    clients: dict[str, Any] = {"client-1": _actor("agent-1")}
    service = _service(clients)
    assert service.get_by_agent_id("agent-1") is clients["client-1"]

    clients["client-1"] = replacement = _actor("agent-1")

    assert service.get_by_agent_id("agent-1") is replacement


def test_a_stopped_actor_is_not_found_and_a_moved_one_is() -> None:
    clients: dict[str, Any] = {"client-1": _actor("agent-1")}
    service = _service(clients)
    assert service.get_by_agent_id("agent-1") is not None

    del clients["client-1"]
    assert service.get_by_agent_id("agent-1") is None

    clients["client-2"] = moved = _actor("agent-1")
    assert service.get_by_agent_id("agent-1") is moved
