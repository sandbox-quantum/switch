from __future__ import annotations

import logging
import re
import uuid
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

import switch_core.bridges.agent.commands as commands
from switch_core.bridges.agent.commands import (
    _check_cancel_usage,
    _check_control_target,
    _cmd_cancel,
    _cmd_reset,
    _cmd_retry,
    parse_cancel_args,
)
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.controller_presence import Binding
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.db.models import CollaborationBridge
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


class _Db:
    """A session holding at most the room's bridge row, read by its id."""

    def __init__(self, bridge: SimpleNamespace | None = None) -> None:
        self.bridge = bridge

    async def get(self, model: Any, ident: str) -> SimpleNamespace | None:
        if model is CollaborationBridge and self.bridge is not None:
            return self.bridge if ident == self.bridge.id else None
        return None


def _bridge(platform: str, **connection_config: str) -> SimpleNamespace:
    return SimpleNamespace(id="b1", type=platform, connection_config=connection_config)


def _client(
    reply: _Reply,
    *,
    command_level: str,
    enqueue: list[Any],
    placed: str | None = None,
    relayed: list[Any] | None = None,
    bridge: SimpleNamespace | None = None,
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
            bridge_id=bridge.id if bridge is not None else None,
            channel_type="channel_private",
        )

    @asynccontextmanager
    async def _session_factory() -> Any:
        yield _Db(bridge)

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


def _meta(bridge_id: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(room_id="room-1", bridge_id=bridge_id)


def _admin_host(
    *,
    agent_names: list[str],
    aliases: dict[str, str],
    role_names: list[str],
    bridge: SimpleNamespace | None = None,
) -> SimpleNamespace:
    @asynccontextmanager
    async def _session_factory() -> Any:
        yield _Db(bridge)

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


@pytest.mark.parametrize("live", [True, False])
@pytest.mark.asyncio
async def test_a_controller_backed_agent_is_sent_the_command_on_its_controllers_stream(
    monkeypatch: pytest.MonkeyPatch, live: bool
) -> None:
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
        assert reply.bodies[-1].startswith("Resetting my session")
    else:
        assert conn.session_commands == []
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
        target_message_id=None,
        turn_id=None,
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
        target_message_id="$m1",
        turn_id=None,
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
            target_message_id=None,
            turn_id=None,
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


def test_other_controls_keep_their_command_ids() -> None:
    # A relayed control is deduplicated by its agent, room, command message and
    # action, and the other controls keep that key.
    for action, body in (
        ("reset", {"type": "session.reset"}),
        ("compact", {"type": "session.compact"}),
        ("interrupt", {"type": "turn.interrupt", "turnId": "current"}),
    ):
        frame = commands.room_control_frame(
            agent_id="a",
            session_id="s",
            room_id="r",
            action=action,
            actor_id="@u:s",
            message_id="m",
            thread_id=None,
            surface="slack",
            requester_name="louisa",
            target_message_id=None,
            turn_id=None,
        )
        assert frame["commandId"] == str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"sdk-control:a:r:m:{action}")
        )
        assert frame["body"] == body


# ── !cancel ───────────────────────────────────────────────────────────────────

TURN = "1b4e28ba-2fa1-51d2-883f-0016d3cca427"


def _cancel_event(args: str) -> CommandEvent:
    return CommandEvent(
        command="cancel",
        args=args,
        user_id="@u:server",
        user_name="louisa",
        message_id="$cancel-command",
        thread_id="$cancel-command",
    )


async def _slack(*_a: Any) -> str:
    return "slack"


def test_a_cancel_names_the_turn_from_its_args() -> None:
    frame = commands.room_control_frame(
        agent_id="a",
        session_id="s",
        room_id="r",
        action="cancel",
        actor_id="@u:s",
        message_id="m",
        thread_id=None,
        surface="slack",
        requester_name="louisa",
        target_message_id=None,
        turn_id=TURN,
    )
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    # Keyed like the other controls: the command message and the action.
    assert frame["commandId"] == str(
        uuid.uuid5(uuid.NAMESPACE_URL, "sdk-control:a:r:m:cancel")
    )


def test_a_cancel_without_a_turn_is_not_a_frame() -> None:
    with pytest.raises(ValueError, match="cancel"):
        commands.room_control_frame(
            agent_id="a",
            session_id="s",
            room_id="r",
            action="cancel",
            actor_id="@u:s",
            message_id="m",
            thread_id=None,
            surface="slack",
            requester_name="louisa",
            target_message_id=None,
            turn_id=None,
        )


@pytest.mark.parametrize(
    "args",
    [
        f"@cc {TURN}",
        f"{TURN} @cc",
        f"@cc   {TURN}  ",
        f"@cc {TURN.upper()}",
        f"@*cc* {TURN}",
        f"@cc @manager {TURN}",
        # Copied off the card or out of the usage line, wrapping and all.
        f"@cc `{TURN}`",
        f"@cc '{TURN}'",
        f'@cc "{TURN}"',
        f"@cc <{TURN}>",
        f"@cc `<{TURN}>`",
        f"@cc `<{TURN.upper()}>`",
    ],
)
def test_cancel_args_name_one_turn(args: str) -> None:
    named = parse_cancel_args(args)
    # A full ID stays a plain str: it goes to the host as it is.
    assert named == TURN
    assert type(named) is str


@pytest.mark.parametrize(
    ("args", "prefix"),
    [
        # The card's eight characters, as copied, wrapped or not.
        (f"@cc {TURN[:8]}", TURN[:8]),
        (f"@cc `{TURN[:8]}`", TURN[:8]),
        (f"@cc '{TURN[:8]}'", TURN[:8]),
        (f'@cc "{TURN[:8]}"', TURN[:8]),
        (f"{TURN[:8]} @cc", TURN[:8]),
        # Case does not matter.
        (f"@cc {TURN[:8].upper()}", TURN[:8]),
        (f"@cc `{TURN[:13].upper()}`", TURN[:13]),
        # More of the ID, up to one character short of it.
        (f"@cc {TURN[:9]}", TURN[:9]),
        (f"@cc {TURN[:20]}", TURN[:20]),
        (f"@cc {TURN[:-1]}", TURN[:-1]),
    ],
)
def test_cancel_args_take_the_start_of_a_turn_id(args: str, prefix: str) -> None:
    assert parse_cancel_args(args) == commands.TurnIdPrefix(prefix)


@pytest.mark.parametrize(
    "args",
    [
        "",
        "@cc",
        "@cc current",
        "@cc CURRENT",
        f"@cc {TURN} {TURN}",
        f"@cc {TURN} please",
        f"@cc {TURN}x",
        f"@cc {TURN.replace('-', '_')}",
        f"@cc {TURN};rm",
        "@cc 1234",
        # Shorter than the card shows.
        f"@cc {TURN[:7]}",
        f"@cc `{TURN[:7]}`",
        # Not hex, or a dash out of place.
        "@cc 1b4e28bz",
        "@cc 1b4e-28ba",
        f"@cc {TURN[:8]}x",
        f"@cc {TURN[:8]}_2fa1",
        f"@cc {TURN[:8]}%",
        f"@cc {TURN[:8]} {TURN[:8]}",
        # Taking the wrapping off does not make a non-ID one.
        "@cc `current`",
        "@cc <current>",
        "@cc `ünïd`",
        f"@cc `{TURN}x`",
        f"@cc `{TURN} {TURN}`",
    ],
)
def test_cancel_args_that_name_no_single_turn_are_refused(args: str) -> None:
    assert parse_cancel_args(args) is None


# ── !cancel with the start of a turn ID ──────────────────────────────────────

# Same first eight characters as TURN.
TWIN = "1b4e28ba-0000-4000-8000-000000000001"
NO_MATCH = (
    "No message waiting for me in this room has an ID that starts with the one "
    "you gave. If I've already started on it, use `!interrupt` with my mention "
    "to stop my current turn."
)
SEVERAL = (
    "More than one message waiting for me in this room has an ID that starts "
    "with the one you gave, so I can't tell which to cancel."
)


class _Turns:
    """`AgentSessionActivityStore` as `_decide_cancel` uses it: turn rows of
    (agent, room, turn ID, status), filtered the way the query filters."""

    def __init__(self, rows: list[tuple[str, str, str, str]]) -> None:
        self.rows = rows
        self.asked: list[tuple[str, str, str]] = []

    def __call__(self) -> _Turns:
        return self

    async def queued_turns_starting_with(
        self, _session: Any, agent_id: str, room_id: str, prefix: str
    ) -> list[SimpleNamespace]:
        self.asked.append((agent_id, room_id, prefix))
        return [
            SimpleNamespace(turn_id=turn_id)
            for agent, room, turn_id, status in self.rows
            if (agent, room, status) == (agent_id, room_id, "queued")
            and turn_id.lower().startswith(prefix.lower())
        ]


async def _cancel_with(
    monkeypatch: pytest.MonkeyPatch,
    args: str,
    rows: list[tuple[str, str, str, str]],
    *,
    placed: str | None = "session-1",
    controller_backed: bool = False,
    bridge: SimpleNamespace | None = None,
) -> tuple[_Reply, list[Any], _Turns]:
    reply = _Reply()
    relayed: list[Any] = []
    turns = _Turns(rows)
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _slack)
    monkeypatch.setattr(commands, "AgentSessionActivityStore", turns)
    client = _client(
        reply,
        command_level="session_dependent",
        enqueue=[],
        placed=placed,
        relayed=relayed,
        bridge=bridge,
    )
    client._connections.controllers.is_bound = lambda _agent: controller_backed

    await _cmd_cancel(
        client, SimpleNamespace(room_id="!m:server"), _cancel_event(args), False
    )
    return reply, relayed, turns


@pytest.mark.asyncio
async def test_a_prefix_matching_one_queued_turn_relays_its_full_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply, relayed, turns = await _cancel_with(
        monkeypatch,
        f"@cc `{TURN[:8].upper()}`",
        [
            ("agent-1", "room-1", TURN, "queued"),
            # The same prefix in another room or with another agent is no match.
            ("agent-1", "room-2", TWIN, "queued"),
            ("agent-2", "room-1", TWIN, "queued"),
        ],
    )

    assert turns.asked == [("agent-1", "room-1", TURN[:8])]
    [frame] = relayed
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    assert reply.bodies == ["Asked my session to cancel that message."]


@pytest.mark.asyncio
async def test_a_prefix_matching_no_queued_turn_is_refused_here(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply, relayed, _ = await _cancel_with(
        monkeypatch,
        f"@cc {TURN[:8]}",
        [("agent-1", "room-2", TURN, "queued"), ("agent-2", "room-1", TURN, "queued")],
    )

    assert reply.bodies == [NO_MATCH]
    assert relayed == []
    # Teams turns a known `@name` into a mention even in code.
    assert "@" not in reply.bodies[0]


@pytest.mark.asyncio
async def test_a_prefix_of_a_started_turn_points_to_interrupt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply, relayed, _ = await _cancel_with(
        monkeypatch, f"@cc {TURN[:8]}", [("agent-1", "room-1", TURN, "running")]
    )

    assert reply.bodies == [NO_MATCH]
    assert "`!interrupt`" in reply.bodies[0]
    assert relayed == []


@pytest.mark.asyncio
async def test_a_prefix_of_a_follow_up_the_host_queued_itself_matches_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply, relayed, _ = await _cancel_with(
        monkeypatch,
        f"@cc {TURN[:8]}",
        [("agent-1", "room-1", f"{TURN}:followup", "queued")],
    )

    assert reply.bodies == [NO_MATCH]
    assert relayed == []


@pytest.mark.asyncio
async def test_a_prefix_matching_several_queued_turns_is_refused_here(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        ("agent-1", "room-1", TURN, "queued"),
        ("agent-1", "room-1", TWIN, "queued"),
    ]
    reply, relayed, _ = await _cancel_with(monkeypatch, f"@cc {TURN[:8]}", rows)

    assert reply.bodies == [SEVERAL]
    assert relayed == []
    assert "@" not in reply.bodies[0]

    # More of the ID tells them apart.
    for longer, full in ((TURN[:10], TURN), (TWIN[:10], TWIN)):
        reply, relayed, _ = await _cancel_with(monkeypatch, f"@cc {longer}", rows)

        [frame] = relayed
        assert frame["body"] == {"type": "turn.cancel", "turnId": full}


@pytest.mark.asyncio
async def test_a_prefix_with_no_session_here_is_told_no_cancel_is_possible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Whether a session here could cancel at all comes first: with none, the
    start of an ID is not looked up, and the room is not sent to `!interrupt`."""
    for rows in ([], [("agent-1", "room-1", TURN, "queued")]):
        reply, relayed, turns = await _cancel_with(
            monkeypatch, f"@cc {TURN[:8]}", rows, placed=None
        )

        assert turns.asked == []
        assert reply.bodies == [commands._CANT_CANCEL]
        assert relayed == []


@pytest.mark.asyncio
async def test_a_controller_backed_agent_has_a_prefix_looked_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply, relayed, turns = await _cancel_with(
        monkeypatch,
        f"@cc {TURN[:8]}",
        [("agent-1", "room-1", TURN, "queued")],
        placed=None,
        controller_backed=True,
    )

    assert turns.asked == [("agent-1", "room-1", TURN[:8])]
    [frame] = relayed
    # The controller routes it to the session working in this room.
    assert frame["sessionId"] is None
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    assert reply.bodies == ["Asked my session to cancel that message."]

    reply, relayed, _ = await _cancel_with(
        monkeypatch, f"@cc {TURN[:8]}", [], placed=None, controller_backed=True
    )
    assert reply.bodies == [NO_MATCH]
    assert relayed == []


@pytest.mark.asyncio
async def test_a_full_id_goes_to_the_host_without_a_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The host decides whether a full ID is still waiting, so core does not
    look it up — even when it has no queued turn on record for it."""
    reply, relayed, turns = await _cancel_with(monkeypatch, f"@cc {TURN.upper()}", [])

    assert turns.asked == []
    [frame] = relayed
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    assert reply.bodies == ["Asked my session to cancel that message."]


@pytest.mark.asyncio
async def test_the_admin_takes_a_prefix_as_valid_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    for args in (f"@cc {TURN[:8]}", f"@cc `{TURN[:8].upper()}`"):
        await _check_cancel_usage(
            _admin_host(agent_names=["cc"], aliases={}, role_names=[]),
            SimpleNamespace(room_id="!m"),
            _cancel_event(args),
            _meta(),
        )
    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[]),
        SimpleNamespace(room_id="!m"),
        _cancel_event(f"@cc {TURN[:7]}"),
        _meta(),
    )

    assert reply.bodies == [commands._CANCEL_USAGE]
    # Seven characters are too few: the usage says how many will do.
    assert "first 8 characters" in reply.bodies[0]
    assert "first 8 characters" in commands.COMMANDS_BY_NAME["cancel"].description


@pytest.mark.asyncio
async def test_a_cancel_is_relayed_with_its_origin_and_a_neutral_ack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    relayed: list[Any] = []
    enqueue: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _slack)

    await _cmd_cancel(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=enqueue,
            placed="session-1",
            relayed=relayed,
        ),
        SimpleNamespace(room_id="!m:server"),
        _cancel_event(f"@cc {TURN}"),
        False,
    )

    [frame] = relayed
    assert frame["sessionId"] == "session-1"
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    # Who asked comes from the command event, never from the message text.
    assert frame["origin"] == {
        "surface": "slack",
        "actorId": "@u:server",
        "roomId": "room-1",
        "threadId": "$cancel-command",
        "messageId": "$cancel-command",
    }
    assert frame["requesterName"] == "louisa"
    # The session answers with the outcome only on some paths, so the ack
    # promises none.
    assert reply.bodies == ["Asked my session to cancel that message."]
    assert "confirm" not in reply.bodies[0]
    assert enqueue == []


@pytest.mark.asyncio
async def test_a_cancel_with_no_controller_connected_is_told_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _slack)

    await _cmd_cancel(
        _client(
            reply, command_level="session_dependent", enqueue=[], placed="session-1"
        ),
        SimpleNamespace(room_id="!m:server"),
        _cancel_event(f"@cc {TURN}"),
        False,
    )

    assert reply.bodies == [
        "Could not send cancel: the agent's controller is not connected to Switch."
    ]


@pytest.mark.parametrize("status", [AgentStatus.LIVE, AgentStatus.DISCONNECTED])
@pytest.mark.parametrize("level", ["session_dependent", "supported", "unsupported"])
@pytest.mark.asyncio
async def test_a_cancel_without_a_relay_says_it_cannot_cancel_from_here(
    monkeypatch: pytest.MonkeyPatch, level: str, status: AgentStatus
) -> None:
    reply = _Reply()
    enqueue: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    _patch_runtime(monkeypatch, status=status, control_capabilities={"cancel": True})

    await _cmd_cancel(
        _client(reply, command_level=level, enqueue=enqueue),
        SimpleNamespace(room_id="!m:server"),
        _cancel_event(f"@cc {TURN}"),
        False,
    )

    assert reply.bodies == [
        "I can't cancel from here — I have no session connected to this room "
        "that could withdraw a queued message."
    ]
    # Whether the session was started from Switch Console is not known here.
    assert "Switch Console" not in reply.bodies[0]
    assert enqueue == []


@pytest.mark.parametrize("args", ["@cc", "@cc current", f"@cc {TURN} {TURN}"])
@pytest.mark.asyncio
async def test_a_misused_cancel_gets_one_reply_from_the_admin(
    monkeypatch: pytest.MonkeyPatch, args: str
) -> None:
    reply = _Reply()
    relayed: list[Any] = []
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", _slack)
    event = _cancel_event(args)

    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[]),
        SimpleNamespace(room_id="!m"),
        event,
        _meta(),
    )
    await _cmd_cancel(
        _client(
            reply,
            command_level="session_dependent",
            enqueue=[],
            placed="session-1",
            relayed=relayed,
        ),
        SimpleNamespace(room_id="!m:server"),
        event,
        False,
    )

    assert reply.bodies == [commands._CANCEL_USAGE]
    assert "all-agents" not in reply.bodies[0]
    # Slack and Teams pass `<…>` through unescaped.
    assert "<" not in reply.bodies[0]
    # Teams turns a known `@name` into a mention even in code.
    assert "@" not in reply.bodies[0]
    assert "@" not in commands.COMMANDS_BY_NAME["cancel"].description
    assert relayed == []


@pytest.mark.asyncio
async def test_cancel_admin_check_without_a_target_has_no_all_agents_advice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[]),
        SimpleNamespace(room_id="!m"),
        _cancel_event(TURN),
        _meta(),
    )

    assert reply.bodies == [commands._CANCEL_USAGE]
    assert "all-agents" not in reply.bodies[0]
    assert "@" not in reply.bodies[0]


@pytest.mark.asyncio
async def test_cancel_admin_check_unknown_target_warns_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    # The ID is bad too, but the target is what is wrong first.
    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[]),
        SimpleNamespace(room_id="!m"),
        _cancel_event("@hames current"),
        _meta(),
    )

    # A role is no target for a cancel, so the reply points to none.
    assert reply.bodies == [
        "`hames` is not an agent in this room. `!cancel` names the agent the "
        "message is queued with, by its name or alias. Run `!list-agents` to "
        "see the agents here."
    ]


@pytest.mark.asyncio
async def test_cancel_admin_check_valid_usage_stays_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    host = _admin_host(
        agent_names=["cc"], aliases={"id-x": "worker"}, role_names=["manager"]
    )

    # An agent's name or alias, with the ID as typed or as copied.
    for args in (f"@cc {TURN}", f"@worker {TURN}", f"@CC `{TURN}`"):
        await _check_cancel_usage(
            host, SimpleNamespace(room_id="!m"), _cancel_event(args), _meta()
        )

    assert reply.bodies == []


# ── !cancel replies where a typed command does not reach Switch ─────────────

SHARED_DISCORD = _bridge("discord", event_delivery="shared")
# Rooms where a typed `!cancel` arrives, so the replies stay as they were:
# none bridged, Discord on a connection of its own, other platforms (Teams too
# says `shared`, for a connection that is given message text).
TYPED_ROOMS = [
    None,
    _bridge("discord", event_delivery="own_connection"),
    _bridge("slack", event_delivery="webhook"),
    _bridge("teams", event_delivery="shared"),
]
SLASH_USAGE = (
    "`/cancel` needs the agent and one turn ID. Run `/cancel` with the agent's "
    "name in `target` and the turn ID from the agent's activity card in "
    "`turn_id`. Its first 8 characters are enough."
)
SLASH_NOT_AN_AGENT = (
    "`hames` is not an agent in this room. `/cancel` takes the agent the "
    "message is queued with in `target`, by its name or alias. Run "
    "`/list-agents` to see the agents here."
)
SLASH_NO_MATCH = (
    "No message waiting for me in this room has an ID that starts with the one "
    "you gave. If I've already started on it, run `/interrupt` with my name in "
    "`target` to stop my current turn."
)


async def _admin_replies(
    monkeypatch: pytest.MonkeyPatch, bridge: SimpleNamespace | None, args: str
) -> list[str]:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[], bridge=bridge),
        SimpleNamespace(room_id="!m"),
        _cancel_event(args),
        _meta(bridge.id if bridge is not None else None),
    )
    return reply.bodies


@pytest.mark.parametrize("args", ["", "@cc", "@cc current"])
@pytest.mark.asyncio
async def test_on_discords_shared_connection_cancel_usage_names_the_slash_command(
    monkeypatch: pytest.MonkeyPatch, args: str
) -> None:
    bodies = await _admin_replies(monkeypatch, SHARED_DISCORD, args)

    assert bodies == [SLASH_USAGE]
    assert "!" not in bodies[0]
    assert "@" not in bodies[0]


@pytest.mark.asyncio
async def test_on_discords_shared_connection_an_unknown_target_names_slash_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bodies = await _admin_replies(monkeypatch, SHARED_DISCORD, "@hames current")

    assert bodies == [SLASH_NOT_AN_AGENT]
    # Discord registers `list-agents` as a slash command.
    listed = commands.COMMANDS_BY_NAME["list-agents"]
    assert not listed.hidden
    assert listed.handler is not None


@pytest.mark.asyncio
async def test_on_discords_shared_connection_the_replies_name_the_registered_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancel = commands.COMMANDS_BY_NAME["cancel"]
    target, turn_id = cancel.args_spec
    renamed = (replace(target, name="agent"), replace(turn_id, name="id"))
    monkeypatch.setitem(
        commands.COMMANDS_BY_NAME, "cancel", replace(cancel, args_spec=renamed)
    )

    assert await _admin_replies(monkeypatch, SHARED_DISCORD, "@cc") == [
        SLASH_USAGE.replace("`target`", "`agent`").replace("`turn_id`", "`id`")
    ]
    assert await _admin_replies(monkeypatch, SHARED_DISCORD, "@hames current") == [
        SLASH_NOT_AN_AGENT.replace("`target`", "`agent`")
    ]


def _fallback_warnings(caplog: pytest.LogCaptureFixture) -> list[tuple[Any, ...]]:
    return [
        tuple(record.args or ())
        for record in caplog.records
        if record.name == "switch_core.bridges.agent.commands"
        and record.levelno == logging.WARNING
        and record.getMessage().startswith(
            "Cannot tell whether typed commands reach Switch through bridge"
        )
    ]


@pytest.mark.parametrize(
    ("bridge", "logged_type"),
    [(None, None), (_bridge("nope", event_delivery="shared"), "nope")],
)
@pytest.mark.asyncio
async def test_a_bridge_that_cannot_be_read_is_taken_to_hear_typed_commands_and_logged(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    bridge: SimpleNamespace | None,
    logged_type: str | None,
) -> None:
    caplog.set_level(logging.WARNING, logger="switch_core.bridges.agent.commands")
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[], bridge=bridge),
        SimpleNamespace(room_id="!m"),
        _cancel_event("@cc"),
        _meta("b1"),
    )

    assert reply.bodies == [commands._CANCEL_USAGE]
    assert _fallback_warnings(caplog) == [("b1", logged_type)]


@pytest.mark.parametrize(
    ("bridge", "bridge_id"),
    [
        (SimpleNamespace(id="b1", type="discord", connection_config=None), "b1"),
        (None, None),
    ],
)
@pytest.mark.asyncio
async def test_a_room_with_no_bridge_or_no_settings_hears_typed_commands_unlogged(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    bridge: SimpleNamespace | None,
    bridge_id: str | None,
) -> None:
    caplog.set_level(logging.WARNING, logger="switch_core.bridges.agent.commands")
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)

    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=[], bridge=bridge),
        SimpleNamespace(room_id="!m"),
        _cancel_event("@cc"),
        _meta(bridge_id),
    )

    assert reply.bodies == [commands._CANCEL_USAGE]
    assert _fallback_warnings(caplog) == []


@pytest.mark.asyncio
async def test_on_discords_shared_connection_no_queued_turn_points_to_slash_interrupt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply, relayed, _ = await _cancel_with(
        monkeypatch, f"@cc {TURN[:8]}", [], bridge=SHARED_DISCORD
    )

    assert reply.bodies == [SLASH_NO_MATCH]
    assert relayed == []
    # The option the text names is the one `interrupt` registers.
    target = commands.COMMANDS_BY_NAME["interrupt"].args_spec[0].name
    assert f"with my name in `{target}`" in reply.bodies[0]


@pytest.mark.parametrize("bridge", TYPED_ROOMS)
@pytest.mark.asyncio
async def test_where_a_typed_command_arrives_the_cancel_replies_are_unchanged(
    monkeypatch: pytest.MonkeyPatch, bridge: SimpleNamespace | None
) -> None:
    assert await _admin_replies(monkeypatch, bridge, "@cc") == [commands._CANCEL_USAGE]
    assert await _admin_replies(monkeypatch, bridge, "@hames current") == [
        "`hames` is not an agent in this room. `!cancel` names the agent the "
        "message is queued with, by its name or alias. Run `!list-agents` to "
        "see the agents here."
    ]
    reply, _, _ = await _cancel_with(monkeypatch, f"@cc {TURN[:8]}", [], bridge=bridge)
    assert reply.bodies == [NO_MATCH]


@asynccontextmanager
async def _addr_session_factory() -> Any:
    yield SimpleNamespace()


def _addr_client(name: str, held_role: str) -> SimpleNamespace:
    """An agent named `name` holding `held_role`, as the targeting sees it."""

    def _tags(token: str, text: str) -> bool:
        return re.search(rf"@{re.escape(token)}(?![A-Za-z0-9._-])", text) is not None

    async def _text_tags_my_alias(_s: Any, _text: str, _room_id: str) -> bool:
        return False

    async def _text_tags_my_role(_s: Any, text: str, _room_id: str) -> bool:
        return _tags(held_role, text)

    return SimpleNamespace(
        session_factory=_addr_session_factory,
        _args_tag_my_name=lambda text: _tags(name, text),
        _text_tags_my_alias=_text_tags_my_alias,
        _text_tags_my_role=_text_tags_my_role,
    )


@pytest.mark.asyncio
async def test_a_cancel_to_a_role_gets_one_reply_and_reaches_no_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    monkeypatch.setattr(commands, "_reply", reply)
    args = f"@manager {TURN}"

    await _check_cancel_usage(
        _admin_host(agent_names=["cc"], aliases={}, role_names=["manager"]),
        SimpleNamespace(room_id="!m"),
        _cancel_event(args),
        _meta(),
    )
    holder = _addr_client("cc", held_role="manager")
    addressed = await commands.COMMANDS_BY_NAME["cancel"].addressed(
        holder, args, "room-1"
    )

    assert reply.bodies == [
        "`manager` is a role. `!cancel` names the agent the message is queued "
        "with, by its name or alias. Run `!list-agents` to see the agents here."
    ]
    # The role's holder is not addressed, so it relays no frame.
    assert addressed is False
    assert (
        await commands.COMMANDS_BY_NAME["cancel"].addressed(
            holder, f"@MANAGER {TURN}", "room-1"
        )
        is False
    )
    # By its own name it is.
    assert (
        await commands.COMMANDS_BY_NAME["cancel"].addressed(
            holder, f"@cc {TURN}", "room-1"
        )
        is True
    )


@pytest.mark.asyncio
async def test_an_interrupt_to_a_role_still_reaches_its_holder() -> None:
    holder = _addr_client("cc", held_role="manager")

    assert (
        await commands.COMMANDS_BY_NAME["interrupt"].addressed(
            holder, "@manager", "room-1"
        )
        is True
    )
