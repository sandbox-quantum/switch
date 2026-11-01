from __future__ import annotations

import re
import uuid
from contextlib import asynccontextmanager
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
            channel_type="channel_private",
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
    # Adding `cancel` must not move the key a relayed control is deduplicated by.
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
    assert parse_cancel_args(args) == TURN


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
        f"@cc {TURN[:-1]}",
        f"@cc {TURN.replace('-', '_')}",
        f"@cc {TURN};rm",
        "@cc 1234",
        # Taking the wrapping off does not make a non-ID one.
        "@cc `current`",
        "@cc <current>",
        "@cc `zły`",
        f"@cc `{TURN}x`",
        f"@cc `{TURN} {TURN}`",
    ],
)
def test_cancel_args_that_name_no_single_turn_are_refused(args: str) -> None:
    assert parse_cancel_args(args) is None


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
    # promises none (U-06).
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
