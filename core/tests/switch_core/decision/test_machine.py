"""Asking the decision model on a machine over its controller's connection
(`decision/machine.py`): the request goes out on the connection's urgent
queue, each answer reaches the request it names, a deadline or a socket
going ends the wait, and the answer is read as the decision service reads
its own llama.cpp server's."""

from __future__ import annotations

import asyncio

import pytest
from switch_decision.models import Agent, DecideRequest, Incoming, Room
from switch_decision.prompt import llamacpp_request

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.decision.machine import MachineDecisionError, MachineDecisions
from tests.switch_core.decision.machine_helpers import (
    MODEL,
    FakeMachine,
    hold,
    letter_for,
    logprobs_body,
)

CONTROLLER = "controller-1"
TENANT = "tenant-1"

REQUEST = DecideRequest(
    room=Room(name="ops"),
    message=Incoming(sender="sam", text="the staging deploy failed, can someone look?"),
    agents=[
        Agent(name="deploy-bot", description="Runs and troubleshoots deploys."),
        Agent(name="billing-bot", description="Invoices and plans."),
    ],
)


def _presence() -> ControllerPresence:
    return ControllerPresence(on_bound=lambda _agent_id: None)


async def _ask(
    machines: MachineDecisions, *, timeout: float = 1.0, threshold: float = 0.6
):
    return await machines.ask(
        controller_id=CONTROLLER,
        model=MODEL,
        request=REQUEST,
        threshold=threshold,
        timeout_seconds=timeout,
    )


async def test_the_request_carries_the_services_own_llamacpp_body() -> None:
    presence = _presence()
    machine = FakeMachine(hold(presence, CONTROLLER, TENANT))
    machine.pick = "deploy-bot"
    async with machine.running():
        answer = await _ask(MachineDecisions(presence), timeout=2.5)

    [frame] = machine.requests
    assert frame["event"] == "decision.request"
    data = frame["data"]
    assert data["kind"] == "llamacpp"
    assert data["model"] == MODEL
    assert data["deadline_ms"] == 2500
    assert data["payload"] == llamacpp_request(REQUEST, 8)[0]
    assert data["payload"]["max_tokens"] == 1
    assert answer.agent == "deploy-bot"
    assert answer.choice == "deploy-bot"
    assert answer.confidence == pytest.approx(0.9)
    assert answer.model_ms == 412


async def test_a_pick_below_the_threshold_names_nobody() -> None:
    presence = _presence()
    machine = FakeMachine(hold(presence, CONTROLLER, TENANT))
    machine.pick = "deploy-bot"
    machine.confidence = 0.55
    async with machine.running():
        answer = await _ask(MachineDecisions(presence), threshold=0.6)

    assert answer.choice == "deploy-bot"
    assert answer.agent is None


async def test_answers_reach_the_requests_they_name_whatever_their_order() -> None:
    presence = _presence()
    conn = hold(presence, CONTROLLER, TENANT)
    machines = MachineDecisions(presence)
    first = asyncio.create_task(_ask(machines))
    second = asyncio.create_task(_ask(machines))
    while len(conn.urgent) < 2:
        await asyncio.sleep(0)
    frames = conn.take_urgent()
    # Answered in reverse: the second request names billing-bot, the first
    # nobody.
    second_id = frames[1]["data"]["request_id"]
    first_id = frames[0]["data"]["request_id"]
    payload = frames[0]["data"]["payload"]
    assert conn.settle_decision(
        {
            "type": "decision.result",
            "request_id": second_id,
            "ok": True,
            "body": logprobs_body(letter_for(payload, "billing-bot"), 0.8),
        }
    )
    assert conn.settle_decision(
        {
            "type": "decision.result",
            "request_id": first_id,
            "ok": True,
            "body": logprobs_body("N", 0.95),
        }
    )

    assert (await second).agent == "billing-bot"
    assert (await first).agent is None
    assert conn.decisions == {}


async def test_no_answer_by_the_deadline_is_a_timeout_and_a_late_one_is_ignored() -> (
    None
):
    presence = _presence()
    conn = hold(presence, CONTROLLER, TENANT)
    machine = FakeMachine(conn)
    machine.silent = True
    async with machine.running():
        with pytest.raises(MachineDecisionError) as failed:
            await _ask(MachineDecisions(presence), timeout=0.05)

    assert failed.value.reason == "timeout"
    assert conn.decisions == {}
    late = machine.requests[0]["data"]["request_id"]
    assert not conn.settle_decision(
        {"type": "decision.result", "request_id": late, "ok": True, "body": {}}
    )


@pytest.mark.parametrize(
    "goes",
    [
        lambda presence, conn: presence.detach_stream(conn, conn.stream_token),
        lambda presence, conn: presence.close_lapsed(conn),
        lambda presence, conn: presence.revoke_controller(conn.controller_id),
        lambda presence, conn: presence.open(
            controller_id=conn.controller_id, tenant_id=TENANT, resume_cursors={}
        ),
    ],
    ids=["socket_closed", "heartbeat_lapsed", "revoked", "taken_over"],
)
async def test_the_connection_going_fails_what_waits_on_it_as_offline(goes) -> None:
    presence = _presence()
    conn = hold(presence, CONTROLLER, TENANT)
    waiting = asyncio.create_task(_ask(MachineDecisions(presence), timeout=5.0))
    while not conn.urgent:
        await asyncio.sleep(0)

    goes(presence, conn)

    with pytest.raises(MachineDecisionError) as failed:
        await asyncio.wait_for(waiting, timeout=1.0)
    assert failed.value.reason == "machine_offline"
    assert conn.decisions == {}


async def test_a_machine_not_held_here_is_offline_at_once() -> None:
    with pytest.raises(MachineDecisionError) as failed:
        await _ask(MachineDecisions(_presence()))

    assert failed.value.reason == "machine_offline"


@pytest.mark.parametrize(
    ("code", "reason"),
    [
        ("busy", "machine_busy"),
        ("not_running", "machine_not_ready"),
        ("model_server_error", "machine_error"),
        ("deadline", "timeout"),
        ("something_new", "machine_error"),
    ],
)
async def test_the_controllers_errors(code: str, reason: str) -> None:
    presence = _presence()
    machine = FakeMachine(hold(presence, CONTROLLER, TENANT))
    machine.error = code
    async with machine.running():
        with pytest.raises(MachineDecisionError) as failed:
            await _ask(MachineDecisions(presence))

    assert failed.value.reason == reason


async def test_an_answer_that_is_not_a_decision_is_a_bad_answer() -> None:
    presence = _presence()
    conn = hold(presence, CONTROLLER, TENANT)
    waiting = asyncio.create_task(_ask(MachineDecisions(presence)))
    while not conn.urgent:
        await asyncio.sleep(0)
    [frame] = conn.take_urgent()
    conn.settle_decision(
        {
            "type": "decision.result",
            "request_id": frame["data"]["request_id"],
            "ok": True,
            "body": {"choices": [{"message": {"content": "deploy-bot"}}]},
        }
    )

    with pytest.raises(MachineDecisionError) as failed:
        await waiting
    assert failed.value.reason == "bad_answer"
