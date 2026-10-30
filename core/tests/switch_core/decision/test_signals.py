"""Reaching the process that holds a workspace's machine over the signal bus
(`decision/signals.py`): a wake goes to the holder alone, and a Test pressed
in another process is answered by the holder, with nothing from any room."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.decision import signals
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.machine import MachineDecisions
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.decision.signals import DecisionSignals
from switch_core.outbound import OutboundPolicy
from tests.conftest import TEST_KEYRING
from tests.switch_core.decision.machine_helpers import MODEL, FakeMachine, hold

CONTROLLER = "controller-1"


class _Network:
    """Every process's bus: a signal published by one reaches the others."""

    def __init__(self) -> None:
        self.buses: list[_Bus] = []
        self.sent: list[dict[str, Any]] = []


class _Bus:
    def __init__(self, network: _Network, process_id: str) -> None:
        self.process_id = process_id
        self._network = network
        self._handlers: dict[str, Callable[[dict[str, Any]], None]] = {}
        network.buses.append(self)

    def handle(self, kind: str, handler: Callable[[dict[str, Any]], None]) -> None:
        self._handlers[kind] = handler

    def publish(self, kind: str, **fields: Any) -> None:
        signal = {"kind": kind, "from": self.process_id, **fields}
        self._network.sent.append(signal)
        for bus in self._network.buses:
            if bus is not self and kind in bus._handlers:
                bus._handlers[kind](signal)


class _Router:
    def __init__(self) -> None:
        self.woken: list[str] = []
        self.wake: Callable[[str, str], None] | None = None

    def use_decision_wakes(self, wake: Callable[[str, str], None]) -> None:
        self.wake = wake

    def wake_decisions(self, tenant_id: str) -> None:
        self.woken.append(tenant_id)


def _client(presence: ControllerPresence) -> DynamicDecisionClient:
    return DynamicDecisionClient(
        session_factory=None,  # type: ignore[arg-type]
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
        machines=MachineDecisions(presence),
    )


def _process(
    network: _Network, process_id: str, presence: ControllerPresence
) -> tuple[_Router, DynamicDecisionClient]:
    router = _Router()
    client = _client(presence)
    DecisionSignals(
        bus=_Bus(network, process_id),  # type: ignore[arg-type]
        router=router,  # type: ignore[arg-type]
        client=client,
    )
    return router, client


async def test_a_wake_reaches_the_holder_alone() -> None:
    network = _Network()
    writer, _ = _process(network, "a", ControllerPresence(on_bound=lambda _a: None))
    holder, _ = _process(network, "b", ControllerPresence(on_bound=lambda _a: None))
    bystander, _ = _process(network, "c", ControllerPresence(on_bound=lambda _a: None))

    assert writer.wake is not None
    writer.wake("b", "tenant-1")

    assert holder.woken == ["tenant-1"]
    assert bystander.woken == [] and writer.woken == []
    assert network.sent == [
        {
            "kind": "decision.wake",
            "from": "a",
            "process_id": "b",
            "tenant_id": "tenant-1",
        }
    ]


async def test_a_test_pressed_elsewhere_is_answered_by_the_holder() -> None:
    network = _Network()
    here = ControllerPresence(on_bound=lambda _a: None)
    here.held_elsewhere(CONTROLLER, "b")
    there = ControllerPresence(on_bound=lambda _a: None)
    machine = FakeMachine(hold(there, CONTROLLER, "tenant-1"))
    machine.pick = "deploy-bot"
    _, asking = _process(network, "a", here)
    _process(network, "b", there)

    async with machine.running():
        outcome = await asking.test_machine(
            controller_id=CONTROLLER, model=MODEL, threshold=None
        )

    assert outcome.ok, outcome
    assert outcome.agent == "deploy-bot"
    assert outcome.backend == "machine"
    assert len(machine.requests) == 1
    tested = [s for s in network.sent if s["kind"] == "decision.tested"]
    assert [s["process_id"] for s in tested] == ["a"]
    # What travels between processes is the sample's outcome, no prompt.
    assert all("payload" not in s and "messages" not in s for s in network.sent)


async def test_a_holder_that_never_answers_reads_as_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(signals, "RELAY_GRACE_SECONDS", 0.0)
    network = _Network()
    here = ControllerPresence(on_bound=lambda _a: None)
    here.held_elsewhere(CONTROLLER, "gone")
    _, asking = _process(network, "a", here)
    asking.timeout_seconds = 0.05

    outcome = await asyncio.wait_for(
        asking.test_machine(controller_id=CONTROLLER, model=MODEL, threshold=None),
        timeout=2,
    )

    assert not outcome.ok
    assert outcome.error_code == "machine_offline"


async def test_a_machine_held_nowhere_is_offline_without_asking_anyone() -> None:
    network = _Network()
    _, asking = _process(network, "a", ControllerPresence(on_bound=lambda _a: None))

    outcome = await asking.test_machine(
        controller_id=CONTROLLER, model=MODEL, threshold=0.6
    )

    assert outcome.error_code == "machine_offline"
    assert network.sent == []
