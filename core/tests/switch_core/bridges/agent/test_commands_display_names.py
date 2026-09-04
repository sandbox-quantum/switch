"""The `!` command surface renders agents under their display name.

An agent's `name` routes; its `display_name` is what a person reads. These
commands print both, one or the other, depending on whether the reader has to
type the name back — and every one of them has to defuse the label first. A
command reply is built here and handed straight to the bridge, which escapes
nothing on the way out but *does* turn a plain `@handle` into a real mention,
so a display name of `@everyone` would otherwise become a mass ping.
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.commands import (
    _cmd_agents_greet,
    _cmd_list_all_agents,
    _cmd_list_documents,
    _cmd_list_room_agents,
    _cmd_roles,
)

# Matches a live `@<handle>` mention token (same char class Switch re-parses).
_MENTION = re.compile(r"@[A-Za-z0-9._-]+")

_FORGED_LINK = "[here](https://example.invalid)"


class _Room(SimpleNamespace):
    pass


def _agent(
    agent_id: str,
    name: str,
    display_name: str | None = None,
    description: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id, name=name, display_name=display_name, description=description
    )


def _document(doc_id: str, name: str, created_by: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=doc_id,
        name=name,
        description="",
        room_id="room-1",
        created_by_agent_id=created_by,
    )


def _role(role_id: str, name: str) -> SimpleNamespace:
    return SimpleNamespace(id=role_id, name=name, exclusive=True)


def _event(command: str) -> SimpleNamespace:
    return SimpleNamespace(command=command, args="", thread_id=None)


def _build_client(
    *,
    agents: dict[str, Any] | None = None,
    roles: list[Any] | None = None,
    holders: dict[str, list[str]] | None = None,
    documents: list[Any] | None = None,
    this_agent: Any = None,
) -> tuple[SimpleNamespace, list[str]]:
    """A fake host client capturing every reply body it posts."""
    posted: list[str] = []
    by_id = dict(agents or {})

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace()

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _reply_command(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        posted.append(body)

    async def _get_agent_ids(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(by_id)

    async def _agent_get(_session, agent_id):  # type: ignore[no-untyped-def]
        return by_id.get(agent_id)

    async def _get_all(_session):  # type: ignore[no-untyped-def]
        return list(by_id.values())

    async def _list_roles(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(roles or [])

    async def _live_holders_for_room(_session, _room_id, _live_ids):  # type: ignore[no-untyped-def]
        return dict(holders or {})

    async def _list_for_room(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(documents or [])

    async def _fresh_agent(_session):  # type: ignore[no-untyped-def]
        return this_agent

    client = SimpleNamespace(
        agent=this_agent,
        _fresh_agent=_fresh_agent,
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        reply_command=_reply_command,
        _frontend_base_url=None,
        _room_store=SimpleNamespace(get_agent_ids=_get_agent_ids),
        _agent_store=SimpleNamespace(get=_agent_get, get_all=_get_all),
        _room_role_store=SimpleNamespace(
            list_roles=_list_roles, live_holders_for_room=_live_holders_for_room
        ),
        _document_store=SimpleNamespace(list_for_room=_list_for_room),
        _connections=SimpleNamespace(live_agent_ids=lambda: set()),
    )
    return client, posted


class TestListRoomAgents:
    async def test_display_name_precedes_the_identifier(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "Switch Dev", "Builds Switch")}
        )
        await _cmd_list_room_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert "- **Switch Dev (`switchdev`)** — Builds Switch" in posted[0]

    async def test_no_display_name_names_the_identifier_once(self) -> None:
        client, posted = _build_client(agents={"a1": _agent("a1", "switchdev")})
        await _cmd_list_room_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert "- **switchdev**" in posted[0]
        assert "(`switchdev`)" not in posted[0]

    async def test_display_name_cannot_ping_the_channel(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "@everyone")}
        )
        await _cmd_list_room_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert _MENTION.search(posted[0]) is None
        assert "switchdev" in posted[0]

    async def test_display_name_cannot_forge_a_link(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", _FORGED_LINK)}
        )
        await _cmd_list_room_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert "](https://example.invalid)" not in posted[0]


class TestListAllAgents:
    async def test_display_name_precedes_the_identifier(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "Switch Dev", "Builds Switch")}
        )
        await _cmd_list_all_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert "- **Switch Dev (`switchdev`)** — Builds Switch" in posted[0]

    async def test_no_display_name_names_the_identifier_once(self) -> None:
        client, posted = _build_client(agents={"a1": _agent("a1", "switchdev")})
        await _cmd_list_all_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert "- **switchdev**" in posted[0]
        assert "(`switchdev`)" not in posted[0]

    async def test_display_name_cannot_ping_the_channel(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "@everyone")}
        )
        await _cmd_list_all_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert _MENTION.search(posted[0]) is None
        assert "switchdev" in posted[0]

    async def test_display_name_cannot_forge_a_link(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", _FORGED_LINK)}
        )
        await _cmd_list_all_agents(client, _Room(room_id="!m:x"), _event("x"), False)
        assert "](https://example.invalid)" not in posted[0]


class TestRoles:
    async def test_holder_is_named_by_its_display_name_alone(self) -> None:
        # Pure attribution: there is nothing here for the reader to type, so
        # the identifier does not need to ride along.
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "Switch Dev")},
            roles=[_role("r1", "reviewer")],
            holders={"r1": ["a1"]},
        )
        await _cmd_roles(client, _Room(room_id="!m:x"), _event("roles"), False)
        assert (
            "- **reviewer** _(exclusive)_ — 🟢 held by Switch Dev"
            == posted[0].splitlines()[1]
        )

    async def test_holder_without_a_display_name_falls_back(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev")},
            roles=[_role("r1", "reviewer")],
            holders={"r1": ["a1"]},
        )
        await _cmd_roles(client, _Room(room_id="!m:x"), _event("roles"), False)
        assert "held by switchdev" in posted[0]

    async def test_holder_display_name_cannot_ping_the_channel(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "@everyone")},
            roles=[_role("r1", "reviewer")],
            holders={"r1": ["a1"]},
        )
        await _cmd_roles(client, _Room(room_id="!m:x"), _event("roles"), False)
        assert _MENTION.search(posted[0]) is None

    async def test_holder_display_name_cannot_forge_a_link(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", _FORGED_LINK)},
            roles=[_role("r1", "reviewer")],
            holders={"r1": ["a1"]},
        )
        await _cmd_roles(client, _Room(room_id="!m:x"), _event("roles"), False)
        assert "](https://example.invalid)" not in posted[0]


class TestListDocuments:
    async def test_creator_is_named_by_its_display_name_alone(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "Switch Dev")},
            documents=[_document("d1", "Runbook", "a1")],
        )
        await _cmd_list_documents(client, _Room(room_id="!m:x"), _event("docs"), False)
        assert "created by Switch Dev" in posted[0]
        assert "(`switchdev`)" not in posted[0]

    async def test_creator_without_a_display_name_falls_back(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev")},
            documents=[_document("d1", "Runbook", "a1")],
        )
        await _cmd_list_documents(client, _Room(room_id="!m:x"), _event("docs"), False)
        assert "created by switchdev" in posted[0]

    async def test_creator_display_name_cannot_ping_the_channel(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", "@everyone")},
            documents=[_document("d1", "Runbook", "a1")],
        )
        await _cmd_list_documents(client, _Room(room_id="!m:x"), _event("docs"), False)
        assert _MENTION.search(posted[0]) is None

    async def test_creator_display_name_cannot_forge_a_link(self) -> None:
        client, posted = _build_client(
            agents={"a1": _agent("a1", "switchdev", _FORGED_LINK)},
            documents=[_document("d1", "Runbook", "a1")],
        )
        await _cmd_list_documents(client, _Room(room_id="!m:x"), _event("docs"), False)
        assert "](https://example.invalid)" not in posted[0]


class TestAgentsGreet:
    async def test_direct_greeting_uses_the_display_name(self) -> None:
        client, posted = _build_client(
            this_agent=_agent("a1", "switchdev", "Switch Dev")
        )
        await _cmd_agents_greet(client, _Room(room_id="!m:x"), _event("greet"), True)
        assert posted[0] == "Hi! I'm Switch Dev — how can I help?"

    async def test_direct_greeting_falls_back_to_the_identifier(self) -> None:
        client, posted = _build_client(this_agent=_agent("a1", "switchdev"))
        await _cmd_agents_greet(client, _Room(room_id="!m:x"), _event("greet"), True)
        assert posted[0] == "Hi! I'm switchdev — how can I help?"

    async def test_direct_greeting_display_name_cannot_ping_the_channel(self) -> None:
        client, posted = _build_client(
            this_agent=_agent("a1", "switchdev", "@everyone")
        )
        await _cmd_agents_greet(client, _Room(room_id="!m:x"), _event("greet"), True)
        assert _MENTION.search(posted[0]) is None

    async def test_direct_greeting_display_name_cannot_forge_a_link(self) -> None:
        client, posted = _build_client(
            this_agent=_agent("a1", "switchdev", _FORGED_LINK)
        )
        await _cmd_agents_greet(client, _Room(room_id="!m:x"), _event("greet"), True)
        assert "](https://example.invalid)" not in posted[0]

    async def test_room_greeting_keeps_the_live_mention_handle(self) -> None:
        # The room greeting exists to teach the reader what to tag, so it stays
        # the routing identifier however the agent is displayed.
        client, posted = _build_client(
            this_agent=_agent("a1", "switchdev", "Switch Dev")
        )
        await _cmd_agents_greet(client, _Room(room_id="!m:x"), _event("greet"), False)
        assert "@switchdev" in posted[0]
        assert "Switch Dev" not in posted[0]

    async def test_greeting_reads_the_agent_fresh(self) -> None:
        # `client.agent` is a boot-time snapshot; a display name edited in the
        # gateway has to show up without restarting the client.
        client, posted = _build_client(this_agent=_agent("a1", "switchdev"))
        client.agent = _agent("a1", "switchdev", "Stale Name")
        await _cmd_agents_greet(client, _Room(room_id="!m:x"), _event("greet"), True)
        assert posted[0] == "Hi! I'm switchdev — how can I help?"
