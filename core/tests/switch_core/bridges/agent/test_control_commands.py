from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

import switch_core.bridges.agent.commands as commands
from switch_core.bridges.agent.commands import (
    _check_control_target,
    _cmd_interrupt,
    _cmd_reset,
)
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
    hosted: bool = False,
    woke: list[Any] | None = None,
) -> SimpleNamespace:
    """Minimal AgentClient stand-in for _dispatch_control_command."""

    agent = SimpleNamespace(
        id="agent-1",
        tenant_id="tenant-1",
        name="cc",
        metadata_={"hosted_launch_id": "launch-1"} if hosted else {},
        integration_profile={
            "command_capabilities": {
                "reset": command_level,
                "interrupt": command_level,
            }
        },
    )

    async def _note_hosted_addressed(noted: Any) -> None:
        assert woke is not None
        woke.append(noted.id)

    def _relay(_agent: str, frame: Any, *, worker_only: bool) -> bool:
        assert worker_only is hosted
        return relayed is not None and (relayed.append(frame) or True)

    async def _fresh_agent(_session: Any) -> SimpleNamespace:
        return agent

    async def _resolve_room_meta(_matrix_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            room_id="room-1",
            name="Room",
            bridge_id="b1",
            channel_type="channel_private",
        )

    @asynccontextmanager
    async def _session_factory() -> Any:
        yield SimpleNamespace()

    async def _agent_room_role(
        _s: Any, _r: str, _a: str, _live_conns: Any = ()
    ) -> None:
        return None

    return SimpleNamespace(
        agent=agent,
        _fresh_agent=_fresh_agent,
        _resolve_room_meta=_resolve_room_meta,
        session_factory=_session_factory,
        tenant_id="tenant-1",
        _note_hosted_addressed=_note_hosted_addressed,
        _agent_session_store=SimpleNamespace(),
        _room_role_store=SimpleNamespace(agent_room_role=_agent_room_role),
        # Presence unions the heartbeat rows with the live connections
        # (CHOO-1857); nothing is connected in these tests.
        _connections=SimpleNamespace(
            live_connection_ids=lambda: set(),
            session_in_room=lambda _agent, _room: placed,
            relay_session_command=_relay,
        ),
        _event_buffer=SimpleNamespace(enqueue=lambda *a, **k: enqueue.append((a, k))),
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
    assert reply.bodies[-1].startswith("Resetting my session")


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
    )
    assert frame["body"] == {"type": "turn.interrupt", "turnId": "current"}


def _patch_launch(monkeypatch: pytest.MonkeyPatch, launch: Any) -> None:
    class _Session:
        async def get(self, _model: Any, key: Any) -> Any:
            assert key == ("tenant-1", "launch-1")
            return launch

    @asynccontextmanager
    async def _tenant_session(_factory: Any, tenant_id: str) -> Any:
        assert tenant_id == "tenant-1"
        yield _Session()

    monkeypatch.setattr(commands, "tenant_session", _tenant_session)


async def _no_surface(*_a: Any) -> str:
    return "slack"


@pytest.mark.asyncio
async def test_reset_of_a_sleeping_hosted_agent_wakes_it_and_queues_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    woke: list[Any] = []
    enqueue: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    _patch_launch(monkeypatch, SimpleNamespace(sleeping=True))

    await _cmd_reset(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=enqueue,
            hosted=True,
            woke=woke,
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert woke == ["agent-1"]
    assert enqueue == []
    assert reply.bodies == [
        "The cloud worker is waking up. The reset was not queued. Wait until the "
        "agent is back (usually about a minute), then send !reset @cc again to "
        "start a fresh conversation."
    ]


@pytest.mark.asyncio
async def test_reset_whose_worker_went_away_after_placement_still_wakes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    woke: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _no_surface)
    _patch_launch(monkeypatch, SimpleNamespace(sleeping=True))

    await _cmd_reset(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=[],
            placed="session-1",
            hosted=True,
            woke=woke,
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert woke == ["agent-1"]
    assert "waking up" in reply.bodies[-1]


@pytest.mark.asyncio
async def test_interrupt_of_a_sleeping_hosted_agent_does_not_wake_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    woke: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    _patch_launch(monkeypatch, SimpleNamespace(sleeping=True))

    await _cmd_interrupt(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=[],
            hosted=True,
            woke=woke,
        ),
        SimpleNamespace(room_id="!m:server"),
        _event("interrupt"),
        False,
    )

    assert woke == []
    assert "asleep" in reply.bodies[-1]


@pytest.mark.asyncio
async def test_an_awake_hosted_agent_relays_to_its_worker_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    relayed: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _no_surface)

    await _cmd_reset(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=[],
            placed="session-1",
            relayed=relayed,
            hosted=True,
            woke=[],
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert len(relayed) == 1
    assert reply.bodies[-1].startswith("Resetting my session")


@pytest.mark.asyncio
async def test_an_awake_hosted_agent_with_no_worker_is_told_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    woke: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _no_surface)
    _patch_launch(monkeypatch, SimpleNamespace(sleeping=False))

    await _cmd_reset(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=[],
            placed="session-1",
            hosted=True,
            woke=woke,
        ),
        SimpleNamespace(room_id="!m:server"),
        _event(),
        False,
    )

    assert woke == []
    assert "controller is not connected" in reply.bodies[-1]
