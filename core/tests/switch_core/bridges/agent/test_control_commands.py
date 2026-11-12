from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

import switch_core.bridges.agent.commands as commands
from switch_core.bridges.agent.commands import (
    _check_control_target,
    _cmd_reset,
    _cmd_retry,
)
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.events import CommandEvent


def _event(command: str = "reset") -> CommandEvent:
    return CommandEvent(
        command=command,
        args="",
        user_id="@u:server",
        user_name="louisa",
        message_id="$reset-command",
        thread_id="$reset-command",
    )


class _Reply:
    def __init__(self) -> None:
        self.bodies: list[str] = []

    async def __call__(
        self, client: Any, room: Any, event: Any, body: str, **kwargs: Any
    ) -> None:
        self.bodies.append(body)


def _client(
    reply: _Reply,
    *,
    command_level: str,
    enqueue: list[Any],
    placed: str | None = None,
    relayed: list[Any] | None = None,
    channel_type: str = "channel_private",
) -> SimpleNamespace:
    """Minimal AgentRecipient stand-in for _dispatch_control_command."""

    agent = SimpleNamespace(
        id="agent-1",
        tenant_id="tenant-1",
        name="cc",
        metadata_={},
        integration_profile={
            "command_capabilities": {
                "reset": command_level,
                "interrupt": command_level,
            }
        },
    )

    def _relay(_agent: str, frame: Any) -> bool:
        return relayed is not None and (relayed.append(frame) or True)

    async def _fresh_agent(_session: Any) -> SimpleNamespace:
        return agent

    async def _resolve_room_meta(_transport_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            room_id="room-1",
            name="Room",
            bridge_id="b1",
            channel_type=channel_type,
        )

    @asynccontextmanager
    async def _session_factory() -> Any:
        yield SimpleNamespace()

    async def _agent_room_role(
        _s: Any, _r: str, _a: str, _live_conns: Any = ()
    ) -> None:
        return None

    async def _enqueue(*a: Any, **k: Any) -> int:
        enqueue.append((a, k))
        return len(enqueue)

    return SimpleNamespace(
        agent=agent,
        _fresh_agent=_fresh_agent,
        _resolve_room_meta=_resolve_room_meta,
        session_factory=_session_factory,
        tenant_id="tenant-1",
        _agent_session_store=SimpleNamespace(),
        _room_role_store=SimpleNamespace(agent_room_role=_agent_room_role),
        # Presence unions the heartbeat rows with the live connections
        # (CHOO-1857); nothing is connected in these tests.
        _connections=SimpleNamespace(
            controllers=SimpleNamespace(is_bound=lambda _agent: False),
            live_connection_ids=lambda: set(),
            session_in_room=lambda _agent, _room: placed,
            relay_session_command=_relay,
        ),
        _event_buffer=SimpleNamespace(enqueue=_enqueue),
    )


def _patch_runtime(
    monkeypatch: pytest.MonkeyPatch,
    *,
    status: AgentStatus,
    control_capabilities: dict[str, bool] | None,
) -> None:
    async def _compute_statuses(*_a: Any, **_k: Any) -> dict[str, AgentStatus]:
        return {"agent-1": status}

    class _RuntimeStore:
        async def get(self, *_a: Any, **_k: Any) -> Any:
            if control_capabilities is None:
                return None
            return SimpleNamespace(
                control_capabilities=control_capabilities, deeplink_url=None
            )

    monkeypatch.setattr(commands, "compute_agent_statuses", _compute_statuses)
    monkeypatch.setattr(commands, "AgentRuntimeStateStore", _RuntimeStore)


@pytest.mark.asyncio
async def test_no_live_session_reports_nothing_to_reset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    enqueue: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    _patch_runtime(
        monkeypatch, status=AgentStatus.NO_SESSION, control_capabilities=None
    )

    await _cmd_reset(
        _client(reply, command_level="session_dependent", enqueue=enqueue),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    # No live session at all → the "nothing to reset" message, NOT the
    # "wasn't started from Switch Console" one, and nothing is enqueued.
    assert len(reply.bodies) == 1
    assert "nothing to reset" in reply.bodies[0]
    assert enqueue == []


@pytest.mark.asyncio
async def test_live_session_without_capability_reports_switchdash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    enqueue: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    # Live session, but it does not report the reset control capability.
    _patch_runtime(
        monkeypatch, status=AgentStatus.LIVE, control_capabilities={"reset": False}
    )

    await _cmd_reset(
        _client(reply, command_level="session_dependent", enqueue=enqueue),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert len(reply.bodies) == 1
    assert "Switch Console" in reply.bodies[0]
    assert enqueue == []


@pytest.mark.asyncio
async def test_live_capable_session_acks_and_enqueues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    enqueue: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    _patch_runtime(
        monkeypatch, status=AgentStatus.LIVE, control_capabilities={"reset": True}
    )

    await _cmd_reset(
        _client(reply, command_level="session_dependent", enqueue=enqueue),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert len(reply.bodies) == 1
    assert "Resetting my session" in reply.bodies[0]
    assert len(enqueue) == 1
    # Queued in the agent's own tenant, which the buffer now takes first.
    assert enqueue[0][0][:3] == ("tenant-1", "agent-1", "room-1")


# ── Admin-side usage feedback (_check_control_target) ─────────────────────────


def _meta() -> SimpleNamespace:
    return SimpleNamespace(room_id="room-1")


def _admin_host(
    *, agent_names: list[str], aliases: dict[str, str], role_names: list[str]
) -> SimpleNamespace:
    @asynccontextmanager
    async def _session_factory() -> Any:
        yield SimpleNamespace()

    ids = [f"id-{n}" for n in agent_names]

    async def _get_agent_ids(_s: Any, _r: str) -> list[str]:
        return ids

    async def _get(_s: Any, aid: str) -> SimpleNamespace:
        name = aid.removeprefix("id-")
        return SimpleNamespace(name=name)

    async def _list_aliases(_s: Any, _r: str) -> dict[str, str]:
        return aliases

    async def _list_roles(_s: Any, _r: str) -> list[SimpleNamespace]:
        return [SimpleNamespace(name=n) for n in role_names]

    return SimpleNamespace(
        session_factory=_session_factory,
        _room_store=SimpleNamespace(
            get_agent_ids=_get_agent_ids, list_aliases=_list_aliases
        ),
        _agent_store=SimpleNamespace(get=_get),
        _room_role_store=SimpleNamespace(list_roles=_list_roles),
    )


def _reset_event(args: str) -> CommandEvent:
    return CommandEvent(
        command="reset", args=args, user_id="@u", user_name="u", thread_id=None
    )


@pytest.mark.asyncio
async def test_admin_check_no_target_prompts_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    host = _admin_host(agent_names=["worker"], aliases={}, role_names=[])

    await _check_control_target(
        host, SimpleNamespace(room_id="!m"), _reset_event(""), _meta()
    )

    assert len(reply.bodies) == 1
    assert "needs a target" in reply.bodies[0]
    assert "reset-all-agents" in reply.bodies[0]


@pytest.mark.asyncio
async def test_admin_check_unknown_target_warns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    host = _admin_host(agent_names=["worker"], aliases={}, role_names=["manager"])

    await _check_control_target(
        host, SimpleNamespace(room_id="!m"), _reset_event("@hames"), _meta()
    )

    assert len(reply.bodies) == 1
    assert "@hames" in reply.bodies[0]
    assert "not an agent or role" in reply.bodies[0]


@pytest.mark.asyncio
async def test_admin_check_valid_target_stays_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    host = _admin_host(
        agent_names=["claude-code.test"],
        aliases={"id-x": "worker"},
        role_names=["manager"],
    )

    # A name, an alias, and a role are all valid targets → no feedback.
    for target in ("@claude-code.test", "@worker", "@manager", "@MANAGER"):
        await _check_control_target(
            host, SimpleNamespace(room_id="!m"), _reset_event(target), _meta()
        )

    assert reply.bodies == []


@pytest.mark.asyncio
async def test_a_session_in_the_room_is_sent_the_command_through_its_controller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    relayed: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)

    async def _surface(*_a: Any) -> str:
        return "slack"

    monkeypatch.setattr(commands, "_room_surface", _surface)

    await _cmd_reset(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=[],
            placed="session-1",
            relayed=relayed,
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    [frame] = relayed
    assert frame["sessionId"] == "session-1"
    assert frame["epoch"] == "current"
    assert frame["body"] == {"type": "session.reset"}
    assert frame["origin"] == {
        "surface": "slack",
        "actorId": "@u:server",
        "roomId": "room-1",
        "threadId": "$reset-command",
        "messageId": "$reset-command",
    }
    assert frame["requesterName"] == "louisa"
    assert "roomTold" not in frame
    assert frame["direct"] is False
    assert reply.bodies[-1].startswith("Resetting my session")


@pytest.mark.asyncio
async def test_a_control_in_a_direct_chat_is_relayed_as_direct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    relayed: list[Any] = []
    monkeypatch.setattr(commands, "_reply", _Reply())

    async def _surface(*_a: Any) -> str:
        return "console"

    monkeypatch.setattr(commands, "_room_surface", _surface)

    await _cmd_reset(
        _client(
            _Reply(),
            command_level="session_dependent",
            enqueue=[],
            placed="session-1",
            relayed=relayed,
            channel_type="direct",
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    [frame] = relayed
    assert frame["direct"] is True


@pytest.mark.asyncio
async def test_a_session_with_no_controller_connected_is_told_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    async def _surface(*_a: Any) -> str:
        return "slack"

    monkeypatch.setattr(commands, "_room_surface", _surface)

    await _cmd_reset(
        _client(
            reply, command_level="session_dependent", enqueue=[], placed="session-1"
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert "controller is not connected" in reply.bodies[-1]


@pytest.fixture
def machine(monkeypatch: pytest.MonkeyPatch):
    """The v1/v2 switch for `!reset` (sweep row 1): set v2 and what the agent's
    controller runs on; records each database read of the machine."""
    from contextlib import asynccontextmanager

    from switch_core import hosted_v2

    reads: list[str] = []

    def _set(*, v2: bool, box: bool) -> list[str]:
        monkeypatch.setattr(hosted_v2, "_process_on", v2)

        @asynccontextmanager
        async def _session(*_a: Any, **_k: Any):
            yield object()

        async def _v2_box(_session: Any, _tenant: str, controller_id: str) -> bool:
            reads.append(controller_id)
            return box

        monkeypatch.setattr(commands, "tenant_session", _session)
        monkeypatch.setattr(commands, "v2_box", _v2_box)
        return reads

    return _set


@pytest.mark.parametrize(("v2", "box"), [(False, True), (False, False), (True, False)])
@pytest.mark.parametrize("live", [True, False])
@pytest.mark.asyncio
async def test_a_reset_on_a_v1_machine_or_own_computer_keeps_upstreams_ack(
    monkeypatch: pytest.MonkeyPatch, machine, live: bool, v2: bool, box: bool
) -> None:
    """Switch off (any controller), or on for a controller not on a box: the
    upstream acknowledgement, no `roomTold`, and upstream's failure line. With
    v2 off, nothing is read."""
    reads = machine(v2=v2, box=box)
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    async def _surface(*_a: Any) -> str:
        return "slack"

    monkeypatch.setattr(commands, "_room_surface", _surface)
    registry = AgentConnectionRegistry()
    registry.controllers.bind(
        Binding(
            agent_id="agent-1",
            controller_id="controller-1",
            tenant_id="tenant",
            controller_name="machine",
            running=True,
        )
    )
    conn = registry.controllers.open(
        controller_id="controller-1", tenant_id="tenant", resume_cursors={}
    )
    if live:
        registry.controllers.attach_stream(conn)
    client = _client(reply, command_level="unsupported", enqueue=[])
    client._connections = registry

    await _cmd_reset(client, SimpleNamespace(room_id="!m:server"), _event(), False)

    assert reads == ([] if not v2 else ["controller-1"])
    if live:
        [(_agent, frame)] = conn.session_commands
        assert "roomTold" not in frame
        assert reply.bodies == [commands._RESET.ack]
    else:
        assert reply.bodies == [
            "Could not send reset: the agent's controller is not connected to Switch."
        ]


@pytest.mark.parametrize("live", [True, False])
@pytest.mark.asyncio
async def test_a_controller_backed_agent_is_sent_the_command_on_its_controllers_stream(
    monkeypatch: pytest.MonkeyPatch, machine, live: bool
) -> None:
    machine(v2=True, box=True)  # a v2 box's agent host says how its reset went
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    async def _surface(*_a: Any) -> str:
        return "slack"

    monkeypatch.setattr(commands, "_room_surface", _surface)
    registry = AgentConnectionRegistry()
    registry.controllers.bind(
        Binding(
            agent_id="agent-1",
            controller_id="controller-1",
            tenant_id="tenant",
            controller_name="machine",
            running=True,
        )
    )
    conn = registry.controllers.open(
        controller_id="controller-1",
        tenant_id="tenant",
        resume_cursors={},
    )
    if live:
        registry.controllers.attach_stream(conn)
    client = _client(reply, command_level="unsupported", enqueue=[])
    client._connections = registry

    await _cmd_reset(client, SimpleNamespace(room_id="!m:server"), _event(), False)

    if live:
        [(agent_id, frame)] = conn.session_commands
        assert agent_id == "agent-1"
        assert frame["sessionId"] is None
        assert frame["origin"]["roomId"] == "room-1"
        assert frame["body"] == {"type": "session.reset"}
        # The box says how the reset went once it knows (an awake
        # session, a resting one cleared, or one it couldn't reset), so Switch
        # no longer claims one is under way when it has only relayed it.
        assert frame["roomTold"] is False
        assert reply.bodies == []
    else:
        assert conn.session_commands == []
        assert reply.bodies == [commands.RESET_NOT_SENT]


def test_an_interrupt_names_the_current_turn() -> None:
    frame = commands.room_control_frame(
        agent_id="a",
        session_id="s",
        room_id="r",
        action="interrupt",
        actor_id="@u:s",
        message_id="m",
        thread_id=None,
        surface="slack",
        requester_name="louisa",
        direct=False,
        target_message_id=None,
    )
    assert frame["body"] == {"type": "turn.interrupt", "turnId": "current"}


def test_a_retry_runs_again_the_message_it_names() -> None:
    assert commands.retry_target("@helper $m1") == "$m1"
    assert commands.retry_target("@helper") is None
    assert commands.retry_target("$m1") is None
    frame = commands.room_control_frame(
        agent_id="a",
        session_id=None,
        room_id="r",
        action="retry",
        actor_id="@u:s",
        message_id="$retry-command",
        thread_id=None,
        surface="switch-web",
        requester_name="louisa",
        direct=False,
        target_message_id="$m1",
    )
    assert frame["body"] == {"type": "message.retry", "messageId": "$m1"}
    with pytest.raises(ValueError):
        commands.room_control_frame(
            agent_id="a",
            session_id=None,
            room_id="r",
            action="retry",
            actor_id="@u:s",
            message_id="$retry-command",
            thread_id=None,
            surface="switch-web",
            requester_name="louisa",
            direct=False,
            target_message_id=None,
        )


@pytest.mark.asyncio
async def test_a_controller_backed_agent_is_relayed_a_retry_of_the_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    async def _surface(*_a: Any) -> str:
        return "switch-web"

    monkeypatch.setattr(commands, "_room_surface", _surface)
    registry = AgentConnectionRegistry()
    registry.controllers.bind(
        Binding(
            agent_id="agent-1",
            controller_id="controller-1",
            tenant_id="tenant",
            controller_name="machine",
            running=True,
        )
    )
    conn = registry.controllers.open(
        controller_id="controller-1", tenant_id="tenant", resume_cursors={}
    )
    registry.controllers.attach_stream(conn)
    client = _client(reply, command_level="unsupported", enqueue=[])
    client._connections = registry

    async def _retryable(*_a: Any) -> None:
        return None

    monkeypatch.setattr(commands, "_retry_refusal", _retryable)
    event = _event("retry")
    event.args = "@agent $m1"
    await _cmd_retry(client, SimpleNamespace(room_id="!m:server"), event, False)

    [(agent_id, frame)] = conn.session_commands
    assert agent_id == "agent-1"
    assert frame["body"] == {"type": "message.retry", "messageId": "$m1"}
    assert reply.bodies[-1] == "Trying that message again."
