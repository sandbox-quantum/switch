from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent import commands
from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_remove_agent
from switch_core.delivery.addressing import AddressingDecision, SenderPrincipal

_ALICE = "user-alice"
_BOB = "user-bob"


def _agent(
    agent_id: str,
    name: str,
    *,
    owner_id: str | None,
    can_manage_agents: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id,
        name=name,
        display_name=None,
        owner_id=owner_id,
        can_manage_agents=can_manage_agents,
    )


_TARGET = _agent("a1", "alice-agent", owner_id=_ALICE)


class _Harness:
    """A fake admin client plus the resolver the command builds.

    `allowed` is what the target's addressing policy says to the sender;
    `principal` is who the sender resolves to; `admins` are the Switch users
    who administer the workspace.
    """

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        *,
        allowed: bool,
        principal: SenderPrincipal | None,
        agents: dict[str, SimpleNamespace],
        room_agent_ids: list[str],
        admins: set[str] = frozenset(),  # type: ignore[assignment]
        aliases: dict[str, str] | None = None,
    ) -> None:
        self.posted: list[str] = []
        self.removed: list[tuple[str, list[str]]] = []
        users = {uid: SimpleNamespace(id=uid) for uid in (_ALICE, _BOB)}

        @asynccontextmanager
        async def _tenant_session(_factory: Any, _tenant_id: str):  # type: ignore[no-untyped-def]
            yield SimpleNamespace(get=_session_get)

        async def _session_get(_model: Any, user_id: str) -> Any:
            return users.get(user_id)

        class _Resolver:
            def __init__(self, **_kw: Any) -> None:
                pass

            async def permitted(self, _session: Any, **_kw: Any) -> AddressingDecision:
                return AddressingDecision(allowed=allowed, refusal="no")

            async def resolve_sender(self, _session: Any, _sender: str) -> Any:
                return principal

        monkeypatch.setattr(commands, "tenant_session", _tenant_session)
        monkeypatch.setattr(commands, "AddressingResolver", _Resolver)

        async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
            return SimpleNamespace(room_id="room-1", name="Feature room")

        async def _reply_command(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
            self.posted.append(body)

        async def _get_agent(_session, agent_id):  # type: ignore[no-untyped-def]
            return agents.get(agent_id)

        async def _get_agent_ids(_session, _room_id):  # type: ignore[no-untyped-def]
            return list(room_agent_ids)

        async def _get_agent_id_by_alias(_session, _room_id, token):  # type: ignore[no-untyped-def]
            return (aliases or {}).get(token)

        async def _administers(_session, user):  # type: ignore[no-untyped-def]
            return user.id in admins

        async def _no_client(_session, _transport_user_id):  # type: ignore[no-untyped-def]
            return None

        async def _remove_agents_from_room(room_id, agent_ids, **_kw):  # type: ignore[no-untyped-def]
            self.removed.append((room_id, list(agent_ids)))

        self.client = SimpleNamespace(
            session_factory=None,
            tenant_id="tenant-1",
            # A sender from a chat platform, which no client here stands for.
            client_store=SimpleNamespace(get_by_transport_user_id=_no_client),
            _resolve_room_meta=_resolve_room_meta,
            reply_command=_reply_command,
            _agent_store=SimpleNamespace(get=_get_agent),
            _room_store=SimpleNamespace(
                get_agent_ids=_get_agent_ids,
                get_agent_id_by_alias=_get_agent_id_by_alias,
            ),
            _room_role_store=None,
            _external_user_store=None,
            _connections=SimpleNamespace(live_connection_ids=lambda: set()),
            _user_store=SimpleNamespace(administers=_administers),
            _room_service=SimpleNamespace(
                remove_agents_from_room=_remove_agents_from_room
            ),
        )

    async def run(self, args: str) -> None:
        event = SimpleNamespace(
            command="remove-agent", args=args, thread_id=None, user_id="@sender:x"
        )
        await _cmd_remove_agent(
            self.client,  # type: ignore[arg-type]
            SimpleNamespace(room_id="!m:x"),  # type: ignore[arg-type]
            event,  # type: ignore[arg-type]
            False,
        )


def _person(*user_ids: str) -> SenderPrincipal:
    return SenderPrincipal("user", "ext-1", list(user_ids), None)


def _agent_sender(agent: SimpleNamespace) -> SenderPrincipal:
    return SenderPrincipal("agent", agent.id, [], agent.owner_id)


class TestRemoveAgentCommand:
    def test_is_registered_as_an_admin_command_with_a_required_target(self) -> None:
        cmd = COMMANDS_BY_NAME["remove-agent"]
        assert cmd.admin_owned
        assert [arg.required for arg in cmd.args_spec] == [True]

    async def test_sender_who_may_address_the_agent_removes_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _Harness(
            monkeypatch,
            allowed=True,
            principal=_person(_ALICE),
            agents={"a1": _TARGET},
            room_agent_ids=["a1"],
        )
        await h.run("@Alice-Agent")
        assert h.removed == [("room-1", ["a1"])]
        assert h.posted == ["Removed **alice-agent** from this room."]

    async def test_alias_names_the_agent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        h = _Harness(
            monkeypatch,
            allowed=True,
            principal=_person(_ALICE),
            agents={"a1": _TARGET},
            room_agent_ids=["a1"],
            aliases={"coder": "a1"},
        )
        await h.run("@coder")
        assert h.removed == [("room-1", ["a1"])]

    async def test_sender_who_may_not_address_it_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _Harness(
            monkeypatch,
            allowed=False,
            principal=_person(_BOB),
            agents={"a1": _TARGET},
            room_agent_ids=["a1"],
        )
        await h.run("@alice-agent")
        assert h.removed == []
        assert "You can't remove **alice-agent**" in h.posted[0]

    async def test_workspace_admin_removes_an_agent_they_may_not_address(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _Harness(
            monkeypatch,
            allowed=False,
            principal=_person(_BOB),
            agents={"a1": _TARGET},
            room_agent_ids=["a1"],
            admins={_BOB},
        )
        await h.run("@alice-agent")
        assert h.removed == [("room-1", ["a1"])]

    async def test_unclaimed_person_is_not_an_admin(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _Harness(
            monkeypatch,
            allowed=False,
            principal=_person(),
            agents={"a1": _TARGET},
            room_agent_ids=["a1"],
            admins={_BOB},
        )
        await h.run("@alice-agent")
        assert h.removed == []

    async def test_managing_agent_removes_its_owners_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        buddy = _agent("b1", "alice-buddy", owner_id=_ALICE, can_manage_agents=True)
        h = _Harness(
            monkeypatch,
            allowed=False,
            principal=_agent_sender(buddy),
            agents={"a1": _TARGET, "b1": buddy},
            room_agent_ids=["a1"],
        )
        await h.run("@alice-agent")
        assert h.removed == [("room-1", ["a1"])]

    async def test_managing_agent_of_another_owner_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        buddy = _agent("b1", "bob-buddy", owner_id=_BOB, can_manage_agents=True)
        h = _Harness(
            monkeypatch,
            allowed=False,
            principal=_agent_sender(buddy),
            agents={"a1": _TARGET, "b1": buddy},
            room_agent_ids=["a1"],
        )
        await h.run("@alice-agent")
        assert h.removed == []

    async def test_agent_not_in_the_room_is_reported(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _Harness(
            monkeypatch,
            allowed=True,
            principal=_person(_ALICE),
            agents={"a1": _TARGET},
            room_agent_ids=[],
        )
        await h.run("@alice-agent")
        assert h.removed == []
        assert "No agent named `alice-agent` in this room" in h.posted[0]

    async def test_missing_target_shows_usage(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _Harness(
            monkeypatch,
            allowed=True,
            principal=_person(_ALICE),
            agents={},
            room_agent_ids=[],
        )
        await h.run("")
        assert h.removed == []
        assert "Usage" in h.posted[0]
