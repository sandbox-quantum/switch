from __future__ import annotations

import re
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent import commands
from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_invite
from switch_core.delivery.addressing import AddressingDecision, SenderPrincipal

# Matches a live `@<handle>` mention token (same char class Switch re-parses).
_MENTION = re.compile(r"@[A-Za-z0-9._-]+")


class _Room(SimpleNamespace):
    pass


def _build_client(
    *,
    registry: dict[str, Any],
    room_agent_ids: list[str],
    monkeypatch: pytest.MonkeyPatch,
    allowed: bool = True,
    principal: SenderPrincipal | None = None,
    agents: dict[str, Any] | None = None,
    admins: frozenset[str] = frozenset(),
) -> tuple[SimpleNamespace, list[str], list[tuple[str, list[str]]]]:
    """A fake admin client capturing replies and add_agents_to_room calls.

    `registry` maps a lowercased agent name to its agent record (mirrors the
    case-insensitive `get_by_name_insensitive` lookup). `allowed` is what the
    target's addressing policy says to the sender, `principal` who the sender
    resolves to, `agents` the agent records by id and `admins` the Switch
    users who administer the workspace.
    """
    posted: list[str] = []
    added: list[tuple[str, list[str]]] = []

    @asynccontextmanager
    async def _tenant_session(_factory: Any, _tenant_id: str):  # type: ignore[no-untyped-def]
        yield SimpleNamespace(get=_session_get)

    async def _session_get(_model: Any, user_id: str) -> Any:
        return SimpleNamespace(id=user_id)

    class _Resolver:
        def __init__(self, **_kw: Any) -> None:
            pass

        async def permitted(self, _session: Any, **_kw: Any) -> AddressingDecision:
            return AddressingDecision(allowed=allowed, refusal="no")

        async def resolve_sender(self, _session: Any, _sender: str) -> Any:
            return principal

    async def _administers_on_record(_session, _factory, _users, user, **_kw):  # type: ignore[no-untyped-def]
        return user.id in admins

    monkeypatch.setattr(commands, "tenant_session", _tenant_session)
    monkeypatch.setattr(commands, "AddressingResolver", _Resolver)
    monkeypatch.setattr(commands, "administers_on_record", _administers_on_record)

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _reply_command(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        posted.append(body)

    async def _get_by_name_insensitive(_session, name):  # type: ignore[no-untyped-def]
        return registry.get(name.lower())

    async def _get_agent(_session, agent_id):  # type: ignore[no-untyped-def]
        return (agents or {}).get(agent_id)

    async def _get_agent_ids(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(room_agent_ids)

    async def _add_agents_to_room(room_id, agent_names=None, **_kw):  # type: ignore[no-untyped-def]
        added.append((room_id, list(agent_names or [])))

    client = SimpleNamespace(
        session_factory=None,
        tenant_id="tenant-1",
        client_store=None,
        _resolve_room_meta=_resolve_room_meta,
        reply_command=_reply_command,
        _agent_store=SimpleNamespace(
            get_by_name_insensitive=_get_by_name_insensitive, get=_get_agent
        ),
        _room_store=SimpleNamespace(get_agent_ids=_get_agent_ids),
        _room_role_store=None,
        _external_user_store=None,
        _connections=SimpleNamespace(live_connection_ids=lambda: set()),
        _user_store=None,
        _room_service=SimpleNamespace(add_agents_to_room=_add_agents_to_room),
    )
    return client, posted, added


def _event(args: str) -> SimpleNamespace:
    return SimpleNamespace(
        command="invite-agent", args=args, thread_id=None, user_id="@sender:x"
    )


def _agent(
    agent_id: str, name: str, display_name: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(id=agent_id, name=name, display_name=display_name)


_ALICE = _agent("a1", "claude-code.alice")


class TestInviteCommand:
    async def test_invites_agent_not_in_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, added = _build_client(
            registry={"claude-code.alice": _ALICE},
            room_agent_ids=["a2"],
            monkeypatch=monkeypatch,
        )
        # Case-insensitive token resolves to the canonical name.
        await _cmd_invite(
            client, _Room(room_id="!m:x"), _event("@Claude-Code.Alice"), False
        )
        assert added == [("room-1", ["claude-code.alice"])]
        assert len(posted) == 1
        assert "claude-code.alice" in posted[0]
        assert "Added" in posted[0]

    async def test_unknown_agent_is_reported(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, added = _build_client(
            registry={}, room_agent_ids=[], monkeypatch=monkeypatch
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@nobody"), False)
        assert added == []
        assert "No agent named" in posted[0]

    async def test_agent_already_in_room(self, monkeypatch: pytest.MonkeyPatch) -> None:
        client, posted, added = _build_client(
            registry={"claude-code.alice": _ALICE},
            room_agent_ids=["a1"],
            monkeypatch=monkeypatch,
        )
        await _cmd_invite(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice"), False
        )
        assert added == []
        assert "already in this room" in posted[0]

    async def test_missing_target_shows_usage(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, added = _build_client(
            registry={}, room_agent_ids=[], monkeypatch=monkeypatch
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event(""), False)
        assert added == []
        assert "Usage" in posted[0]


class TestInviteCommandDisplayNames:
    async def test_added_notice_names_the_agent_and_keeps_its_identifier(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        agent = _agent("a1", "switchdev", "Switch Dev")
        client, posted, added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=[], monkeypatch=monkeypatch
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        # Routing still goes by the identifier, whatever it is displayed as.
        assert added == [("room-1", ["switchdev"])]
        assert "Added **Switch Dev (`switchdev`)** to this room." == posted[0]

    async def test_already_present_notice_names_the_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        agent = _agent("a1", "switchdev", "Switch Dev")
        client, posted, _added = _build_client(
            registry={"switchdev": agent},
            room_agent_ids=["a1"],
            monkeypatch=monkeypatch,
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        assert "**Switch Dev (`switchdev`)** is already in this room." == posted[0]

    async def test_no_display_name_names_the_identifier_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, _added = _build_client(
            registry={"claude-code.alice": _ALICE},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
        )
        await _cmd_invite(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice"), False
        )
        assert "Added **claude-code.alice** to this room." == posted[0]
        assert "(`claude-code.alice`)" not in posted[0]

    async def test_display_name_cannot_ping_the_channel(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        agent = _agent("a1", "switchdev", "@everyone")
        client, posted, _added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=[], monkeypatch=monkeypatch
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        assert _MENTION.search(posted[0]) is None
        assert "switchdev" in posted[0]

    async def test_display_name_cannot_forge_a_link(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        agent = _agent("a1", "switchdev", "[here](https://example.invalid)")
        client, posted, _added = _build_client(
            registry={"switchdev": agent},
            room_agent_ids=["a1"],
            monkeypatch=monkeypatch,
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdev"), False)
        assert "](https://example.invalid)" not in posted[0]

    async def test_unknown_token_is_echoed_verbatim(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        agent = _agent("a1", "switchdev", "Switch Dev")
        client, posted, _added = _build_client(
            registry={"switchdev": agent}, room_agent_ids=[], monkeypatch=monkeypatch
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@switchdevv"), False)
        assert "No agent named `switchdevv`" in posted[0]
        assert "Switch Dev" not in posted[0]


_OWNED = SimpleNamespace(
    id="a1",
    name="alice-agent",
    display_name=None,
    owner_id="user-alice",
    can_manage_agents=False,
)


def _manager(owner_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        id="m1",
        name="manager",
        display_name=None,
        owner_id=owner_id,
        can_manage_agents=True,
    )


class TestInviteRespectsAddressing:
    """`!invite-agent` asks the rule `!remove-agent` asks: does the agent take
    instructions from the sender in this room?"""

    async def test_someone_the_policy_admits_invites(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
            allowed=True,
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == [("room-1", ["alice-agent"])]
        assert posted == ["Added **alice-agent** to this room."]

    async def test_someone_the_policy_refuses_is_told_why_and_who_can(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
            allowed=False,
            principal=SenderPrincipal("user", "ext-bob", ["user-bob"], None),
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == []
        assert posted == [
            "You can't invite **alice-agent**: it doesn't take instructions "
            "from you. Ask its owner to invite it, or to let you talk to it."
        ]

    async def test_an_unclaimed_chat_account_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
            allowed=False,
            principal=None,
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == []
        assert "You can't invite" in posted[0]

    async def test_a_workspace_admin_may_invite(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, _posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
            allowed=False,
            principal=SenderPrincipal("user", "ext-carol", ["user-carol"], None),
            admins=frozenset({"user-carol"}),
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == [("room-1", ["alice-agent"])]

    async def test_the_owners_managing_agent_may_invite(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        manager = _manager("user-alice")
        client, _posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
            allowed=False,
            principal=SenderPrincipal("agent", "m1", [], "user-alice"),
            agents={"m1": manager},
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == [("room-1", ["alice-agent"])]

    async def test_someone_elses_managing_agent_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        manager = _manager("user-bob")
        client, posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=[],
            monkeypatch=monkeypatch,
            allowed=False,
            principal=SenderPrincipal("agent", "m1", [], "user-bob"),
            agents={"m1": manager},
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == []
        assert "You can't invite" in posted[0]

    async def test_already_present_is_reported_before_the_policy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # An agent already in the room is never removed or re-checked.
        client, posted, added = _build_client(
            registry={"alice-agent": _OWNED},
            room_agent_ids=["a1"],
            monkeypatch=monkeypatch,
            allowed=False,
        )
        await _cmd_invite(client, _Room(room_id="!m:x"), _event("@alice-agent"), False)
        assert added == []
        assert "already in this room" in posted[0]


class TestInviteCommandRegistration:
    def test_invite_is_admin_owned(self) -> None:
        # The always-present admin client owns and executes `!invite-agent`;
        # agents never run it (only the admin client holds a room_service
        # reference).
        cmd = COMMANDS_BY_NAME["invite-agent"]
        assert cmd.admin_owned is True
