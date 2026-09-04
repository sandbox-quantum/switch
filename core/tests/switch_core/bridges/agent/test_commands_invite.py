from __future__ import annotations

import re
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_invite

# Matches a live `@<handle>` mention token (same char class Switch re-parses).
_MENTION = re.compile(r"@[A-Za-z0-9._-]+")


class _Room(SimpleNamespace):
    pass


def _build_client(
    *, registry: dict[str, Any], room_agent_ids: list[str]
) -> tuple[SimpleNamespace, list[str], list[tuple[str, list[str]]]]:
    """A fake admin client capturing replies and add_agents_to_room calls.

    `registry` maps a lowercased agent name to its agent record (mirrors the
    case-insensitive `get_by_name_insensitive` lookup).
    """
    posted: list[str] = []
    added: list[tuple[str, list[str]]] = []

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _reply_command(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        posted.append(body)

    async def _get_by_name_insensitive(_session, name):  # type: ignore[no-untyped-def]
        return registry.get(name.lower())

    async def _get_agent_ids(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(room_agent_ids)

    async def _add_agents_to_room(room_id, agent_names=None, **_kw):  # type: ignore[no-untyped-def]
        added.append((room_id, list(agent_names or [])))

    client = SimpleNamespace(
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        reply_command=_reply_command,
        _agent_store=SimpleNamespace(get_by_name_insensitive=_get_by_name_insensitive),
        _room_store=SimpleNamespace(get_agent_ids=_get_agent_ids),
        _room_service=SimpleNamespace(add_agents_to_room=_add_agents_to_room),
    )
    return client, posted, added


def _event(args: str) -> SimpleNamespace:
    return SimpleNamespace(command="invite-agent", args=args, thread_id=None)


def _agent(
    agent_id: str, name: str, display_name: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(id=agent_id, name=name, display_name=display_name)


_ALICE = _agent("a1", "claude-code.alice")


class TestInviteCommand:
    async def test_invites_agent_not_in_room(self) -> None:
        client, posted, added = _build_client(
            registry={"claude-code.alice": _ALICE}, room_agent_ids=["a2"]
        )
        # Case-insensitive token resolves to the canonical name.
        await _cmd_invite(
            client, _Room(room_id="!m:x"), _event("@Claude-Code.Alice"), False
        )
        assert added == [("room-1", ["claude-code.alice"])]
        assert len(posted) == 1
        assert "claude-code.alice" in posted[0]
        assert "Added" in posted[0]

    async def test_unknown_agent_is_reported(self) -> None:
        client, posted, added = _build_client(registry={}, room_agent_ids=[])
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@nobody"), False)
        assert added == []
        assert "No agent named" in posted[0]

    async def test_agent_already_in_room(self) -> None:
        client, posted, added = _build_client(
            registry={"claude-code.alice": _ALICE}, room_agent_ids=["a1"]
        )
        await _cmd_invite(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice"), False
        )
        assert added == []
        assert "already in this room" in posted[0]

    async def test_missing_target_shows_usage(self) -> None:
        client, posted, added = _build_client(registry={}, room_agent_ids=[])
        await _cmd_invite(client, _Room(room_id="!m:x"), _event(""), False)
        assert added == []
        assert "Usage" in posted[0]


class TestInviteCommandDisplayNames:
    async def test_added_notice_names_the_agent_and_keeps_its_identifier(self) -> None:
        agent = _agent("a1", "switchdev", "Switch Dev")
        client, posted, added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=[]
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        # Routing still goes by the identifier, whatever it is displayed as.
        assert added == [("room-1", ["switchdev"])]
        assert "Added **Switch Dev (`switchdev`)** to this room." == posted[0]

    async def test_already_present_notice_names_the_agent(self) -> None:
        agent = _agent("a1", "switchdev", "Switch Dev")
        client, posted, _added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=["a1"]
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        assert "**Switch Dev (`switchdev`)** is already in this room." == posted[0]

    async def test_no_display_name_names_the_identifier_once(self) -> None:
        client, posted, _added = _build_client(
            registry={"claude-code.alice": _ALICE}, room_agent_ids=[]
        )
        await _cmd_invite(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice"), False
        )
        assert "Added **claude-code.alice** to this room." == posted[0]
        assert "(`claude-code.alice`)" not in posted[0]

    async def test_display_name_cannot_ping_the_channel(self) -> None:
        agent = _agent("a1", "switchdev", "@everyone")
        client, posted, _added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=[]
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        assert _MENTION.search(posted[0]) is None
        assert "switchdev" in posted[0]

    async def test_display_name_cannot_forge_a_link(self) -> None:
        agent = _agent("a1", "switchdev", "[here](https://example.invalid)")
        client, posted, _added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=["a1"]
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        assert "](https://example.invalid)" not in posted[0]

    async def test_unknown_token_is_echoed_verbatim(self) -> None:
        agent = _agent("a1", "switchdev", "Switch Dev")
        client, posted, _added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=[]
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdevv"), False)
        assert "No agent named `switchdevv`" in posted[0]
        assert "Switch Dev" not in posted[0]


class TestInviteCommandRegistration:
    def test_invite_is_admin_owned(self) -> None:
        # The always-present admin client owns and executes `!invite-agent`;
        # agents never run it (only the admin client holds a room_service
        # reference).
        cmd = COMMANDS_BY_NAME["invite-agent"]
        assert cmd.admin_owned is True
