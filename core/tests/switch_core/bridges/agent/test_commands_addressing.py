"""An admin-owned command that acts on an agent obeys that agent's addressing
policy, exactly as a message to it would.

The agents gate their own commands as they run (`AgentClient._gate_command`).
These are the ones the admin client runs *on an agent's behalf* — aliasing it,
inviting it into a room — which would otherwise reach a restricted agent
through a door the policy never covered.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    dispatch_admin_command,
    resolve_command_target,
)
from switch_core.clients.admin_client import AdminClient
from switch_core.delivery.addressing import (
    ADDRESSING_DENIED_MESSAGE,
    AddressingDecision,
)

pytestmark = pytest.mark.asyncio

RESTRICTED = SimpleNamespace(id="a-restricted", name="restricted", display_name=None)
OPEN = SimpleNamespace(id="a-open", name="open-agent", display_name=None)


def _host(
    *,
    allowed: bool,
    aliases: dict[str, str] | None = None,
    agents: dict[str, Any] | None = None,
) -> SimpleNamespace:
    """A fake admin client recording replies, handler runs and policy checks."""
    agents = agents if agents is not None else {a.id: a for a in (RESTRICTED, OPEN)}
    aliases = aliases or {}
    posted: list[str] = []
    checked: list[str] = []

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _reply_command(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        posted.append(body)

    async def _get_agent_id_by_alias(_session, _room_id, token):  # type: ignore[no-untyped-def]
        return aliases.get(token.lower())

    async def _get(_session, agent_id):  # type: ignore[no-untyped-def]
        return agents.get(agent_id)

    async def _get_by_name_insensitive(_session, name):  # type: ignore[no-untyped-def]
        return next(
            (a for a in agents.values() if a.name.lower() == name.lower()), None
        )

    async def _permitted(_session, *, agent, room_id, sender):  # type: ignore[no-untyped-def]
        checked.append(agent.name)
        return AddressingDecision(
            allowed=allowed,
            refusal="" if allowed else ADDRESSING_DENIED_MESSAGE,
        )

    async def _is_direct_room(_room_id: str) -> bool:
        return False

    host = SimpleNamespace(
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        reply_command=_reply_command,
        _is_direct_room=_is_direct_room,
        _room_store=SimpleNamespace(get_agent_id_by_alias=_get_agent_id_by_alias),
        _agent_store=SimpleNamespace(
            get=_get, get_by_name_insensitive=_get_by_name_insensitive
        ),
        _addressing=SimpleNamespace(permitted=_permitted),
        posted=posted,
        checked=checked,
    )
    # The real gate, so dispatch exercises production code rather than a stub.
    host.command_refusal = partial(AdminClient.command_refusal, host)
    return host


def _room() -> SimpleNamespace:
    return SimpleNamespace(room_id="!matrix:switch.local")


def _event(command: str, args: str) -> SimpleNamespace:
    return SimpleNamespace(
        command=command, args=args, thread_id="$cmd", user_id="@intruder:switch.local"
    )


def _patch_handler(monkeypatch: pytest.MonkeyPatch, command: str) -> list[str]:
    """Replace a command's handler so we can see whether it ever ran."""
    ran: list[str] = []
    cmd = COMMANDS_BY_NAME[command]

    async def _handler(_client, _room, event, _is_direct):  # type: ignore[no-untyped-def]
        ran.append(event.args)

    monkeypatch.setitem(COMMANDS_BY_NAME, command, replace(cmd, handler=_handler))
    return ran


TARGETING_COMMANDS = [
    ("set-alias", "@restricted @shorty"),
    ("remove-alias", "@restricted"),
    ("invite-agent", "@restricted"),
]


class TestRefusedWhenSenderMayNotAddressTarget:
    @pytest.mark.parametrize(("command", "args"), TARGETING_COMMANDS)
    async def test_command_is_refused_and_never_runs(
        self, monkeypatch: pytest.MonkeyPatch, command: str, args: str
    ) -> None:
        ran = _patch_handler(monkeypatch, command)
        host = _host(allowed=False)

        await dispatch_admin_command(host, _room(), _event(command, args))

        assert ran == [], "a refused command must not execute"
        assert host.posted == [ADDRESSING_DENIED_MESSAGE]
        assert host.checked == ["restricted"]

    async def test_refusal_is_explicit_not_a_silent_no_op(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_handler(monkeypatch, "invite-agent")
        host = _host(allowed=False)

        await dispatch_admin_command(
            host, _room(), _event("invite-agent", "@restricted")
        )

        assert host.posted and "not permitted" in host.posted[0]


class TestAllowedSenderIsUnaffected:
    @pytest.mark.parametrize(("command", "args"), TARGETING_COMMANDS)
    async def test_command_runs(
        self, monkeypatch: pytest.MonkeyPatch, command: str, args: str
    ) -> None:
        ran = _patch_handler(monkeypatch, command)
        host = _host(allowed=True)

        await dispatch_admin_command(host, _room(), _event(command, args))

        assert ran == [args]
        assert host.posted == []


class TestNonTargetingCommandsAreNotGated:
    @pytest.mark.parametrize("command", ["list-agents", "list-aliases", "room-url"])
    async def test_informational_command_skips_the_policy(
        self, monkeypatch: pytest.MonkeyPatch, command: str
    ) -> None:
        # These report on the room; they do not act on an agent, so a caller
        # who cannot address an agent may still run them.
        ran = _patch_handler(monkeypatch, command)
        host = _host(allowed=False)

        await dispatch_admin_command(host, _room(), _event(command, ""))

        assert ran == [""]
        assert host.checked == []


class TestUnresolvableTarget:
    async def test_handler_runs_and_gives_its_own_notice(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # No agent by that name: the handler's "no such agent" reply is the
        # useful answer, and the policy could not have applied anyway.
        ran = _patch_handler(monkeypatch, "invite-agent")
        host = _host(allowed=False)

        await dispatch_admin_command(host, _room(), _event("invite-agent", "@ghost"))

        assert ran == ["@ghost"]
        assert host.checked == []


class TestResolveCommandTarget:
    async def test_prefers_a_room_alias(self) -> None:
        host = _host(allowed=True, aliases={"shorty": RESTRICTED.id})
        async with host.session_factory() as session:
            target = await resolve_command_target(host, session, "room-1", "@shorty")
        assert target is RESTRICTED

    async def test_falls_back_to_the_agent_name_case_insensitively(self) -> None:
        host = _host(allowed=True)
        async with host.session_factory() as session:
            target = await resolve_command_target(
                host, session, "room-1", "@RESTRICTED"
            )
        assert target is RESTRICTED

    async def test_no_mention_resolves_to_nothing(self) -> None:
        host = _host(allowed=True)
        async with host.session_factory() as session:
            assert await resolve_command_target(host, session, "room-1", "") is None


class TestCommandRefusalSurface:
    async def test_allowed_target_returns_no_refusal(self) -> None:
        host = _host(allowed=True)
        refusal = await AdminClient.command_refusal(
            host, _event("invite-agent", "@restricted"), "room-1"
        )
        assert refusal is None

    async def test_denied_target_returns_the_refusal_text(self) -> None:
        host = _host(allowed=False)
        refusal = await AdminClient.command_refusal(
            host, _event("invite-agent", "@restricted"), "room-1"
        )
        assert refusal == ADDRESSING_DENIED_MESSAGE
