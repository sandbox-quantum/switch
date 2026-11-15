"""A running client is found by its agent or its type without looking at
every client's actor, and a lookup still finds the actor running now after it
was replaced."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from switch_core.clients.actor import AgentActor, SystemActor
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from tests.ownership import NeverOwned

_TENANT = "tenant-a"


class _CountingScans(dict[str, Any]):
    scans = 0

    def items(self):  # type: ignore[no-untyped-def,override]
        self.scans += 1
        return super().items()

    def __iter__(self):  # type: ignore[no-untyped-def]
        self.scans += 1
        return super().__iter__()


class _Agent(AgentActor):
    """An agent's actor that counts how often its agent is asked for."""

    asked = 0

    @property
    def agent_id(self) -> str | None:
        _Agent.asked += 1
        return self._agent.id if self._agent is not None else None


def _actor(agent_id: str | None) -> _Agent:
    actor = _Agent.__new__(_Agent)
    actor._agent = None if agent_id is None else SimpleNamespace(id=agent_id)  # type: ignore[assignment]
    return actor


def _service() -> ClientLifecycleService:
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
    service._clients = _CountingScans()
    return service


def _running(count: int) -> ClientLifecycleService:
    service = _service()
    for n in range(count):
        service._track(f"client-{n}", _actor(f"agent-{n}"), "agent", _TENANT)
    return service


def test_an_agent_is_found_without_looking_at_any_other_actor() -> None:
    service = _running(1000)
    _Agent.asked = 0

    found = service.get_by_agent_id("agent-500")

    assert found is service._clients["client-500"]
    assert _Agent.asked == 1
    assert service._clients.scans == 0  # type: ignore[attr-defined]


def test_an_agent_not_running_here_is_answered_without_looking() -> None:
    """At 10,000 agents, every lookup of an agent another process had just
    registered read every actor here, and creating agents made that one
    lookup per agent."""
    service = _running(1000)
    _Agent.asked = 0

    assert service.get_by_agent_id("agent-elsewhere") is None
    assert _Agent.asked == 0


def test_an_agent_whose_row_comes_later_is_found_and_kept() -> None:
    """A client registered here reads its agent row as it connects."""
    service = _running(10)
    late = _actor(None)
    service._track("client-late", late, "agent", _TENANT)
    late._agent = SimpleNamespace(id="agent-late")  # type: ignore[assignment]

    assert service.get_by_agent_id("agent-late") is late
    _Agent.asked = 0
    assert service.get_by_agent_id("agent-late") is late
    assert _Agent.asked == 1


def test_a_replaced_actor_is_the_one_found() -> None:
    service = _running(1)
    assert service.get_by_agent_id("agent-0") is service._clients["client-0"]

    replacement = _actor("agent-0")
    service._track("client-0", replacement, "agent", _TENANT)

    assert service.get_by_agent_id("agent-0") is replacement


def test_a_stopped_actor_is_not_found_and_a_moved_one_is() -> None:
    service = _running(1)
    assert service.get_by_agent_id("agent-0") is not None

    service._forget("client-0")
    assert service.get_by_agent_id("agent-0") is None

    moved = _actor("agent-0")
    service._track("client-1", moved, "agent", _TENANT)
    assert service.get_by_agent_id("agent-0") is moved


def test_a_type_is_found_without_looking_at_every_client() -> None:
    """A room created asks for its tenant's admin, and with thousands of
    agents running that read every one of them."""
    service = _running(1000)
    admin = SystemActor.__new__(SystemActor)
    service._track("client-admin", admin, "admin", _TENANT)
    service._track("client-other-admin", admin, "admin", "tenant-b")

    assert service.get_by_type("admin", _TENANT) == [admin]
    assert service._clients.scans == 0  # type: ignore[attr-defined]

    service._forget("client-admin")
    assert service.get_by_type("admin", _TENANT) == []
