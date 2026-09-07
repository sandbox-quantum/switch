from __future__ import annotations

import re
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    _cmd_list_aliases,
    _cmd_set_alias,
)

# Matches a live `@<handle>` mention token (same char class Switch re-parses).
_MENTION = re.compile(r"@[A-Za-z0-9._-]+")


class _Room(SimpleNamespace):
    pass


def _build_client(
    *, agents: dict[str, Any], aliases: dict[str, str], role_names: list[str]
) -> tuple[SimpleNamespace, list[str]]:
    """A fake moderator client capturing every reply body it posts."""
    posted: list[str] = []
    state = {"aliases": dict(aliases)}

    async def _commit() -> None:
        return None

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield SimpleNamespace(commit=_commit)

    async def _resolve_room_meta(_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id="room-1", name="Feature room")

    async def _send_message(_room_id, body, **_kw):  # type: ignore[no-untyped-def]
        posted.append(body)

    async def _get_agent_ids(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(agents)

    async def _agent_get(_session, agent_id):  # type: ignore[no-untyped-def]
        return agents.get(agent_id)

    async def _list_aliases(_session, _room_id):  # type: ignore[no-untyped-def]
        return dict(state["aliases"])

    async def _set_alias(_session, _room_id, agent_id, alias):  # type: ignore[no-untyped-def]
        if alias is None:
            state["aliases"].pop(agent_id, None)
        else:
            state["aliases"][agent_id] = alias

    async def _list_roles(_session, _room_id):  # type: ignore[no-untyped-def]
        return [SimpleNamespace(id=f"r-{n}", name=n) for n in role_names]

    client = SimpleNamespace(
        agent=SimpleNamespace(id="mod", name="moderator", role="moderator"),
        session_factory=_session_factory,
        _resolve_room_meta=_resolve_room_meta,
        send_message=_send_message,
        reply_command=_send_message,
        _room_store=SimpleNamespace(
            get_agent_ids=_get_agent_ids,
            list_aliases=_list_aliases,
            set_alias=_set_alias,
        ),
        _agent_store=SimpleNamespace(get=_agent_get),
        _room_role_store=SimpleNamespace(list_roles=_list_roles),
    )
    return client, posted


def _event(args: str) -> SimpleNamespace:
    return SimpleNamespace(command="set-alias", args=args, thread_id=None)


def _agent(
    agent_id: str, name: str, display_name: str | None = None
) -> SimpleNamespace:
    return SimpleNamespace(id=agent_id, name=name, display_name=display_name)


_AGENTS = {
    "a1": _agent("a1", "claude-code.alice"),
    "a2": _agent("a2", "moderator"),
}


class TestSetAliasCommand:
    async def test_sets_alias_and_reply_has_no_live_mention(self) -> None:
        client, posted = _build_client(agents=_AGENTS, aliases={}, role_names=[])
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice @boss"), False
        )
        # The alias was persisted.
        assert await client._room_store.list_aliases(None, "room-1") == {"a1": "boss"}
        # The confirmation must NOT contain a live `@<alias>` that Switch would
        # re-parse as a mention and address the freshly-aliased agent.
        assert len(posted) == 1
        assert _MENTION.search(posted[0]) is None
        assert "boss" in posted[0]

    async def test_rejects_alias_clashing_with_role(self) -> None:
        client, posted = _build_client(
            agents=_AGENTS, aliases={}, role_names=["manager"]
        )
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice @manager"), False
        )
        assert await client._room_store.list_aliases(None, "room-1") == {}
        assert "⚠️" in posted[0]
        assert _MENTION.search(posted[0]) is None


class TestListAliasesCommand:
    async def test_list_reply_has_no_live_mention(self) -> None:
        client, posted = _build_client(
            agents=_AGENTS, aliases={"a1": "boss"}, role_names=[]
        )
        await _cmd_list_aliases(client, _Room(room_id="!m:x"), _event(""), False)
        assert "boss" in posted[0]
        assert _MENTION.search(posted[0]) is None


class TestAliasCommandsRenderDisplayNames:
    async def test_set_alias_names_the_agent_and_keeps_its_identifier(self) -> None:
        agents = {"a1": _agent("a1", "switchdev", "Switch Dev")}
        client, posted = _build_client(agents=agents, aliases={}, role_names=[])
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@switchdev @boss"), False
        )
        assert "Switch Dev (`switchdev`)" in posted[0]

    async def test_set_alias_without_a_display_name_names_it_once(self) -> None:
        client, posted = _build_client(agents=_AGENTS, aliases={}, role_names=[])
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@claude-code.alice @boss"), False
        )
        assert "**claude-code.alice**" in posted[0]
        assert "(`claude-code.alice`)" not in posted[0]

    async def test_set_alias_display_name_cannot_ping_the_channel(self) -> None:
        agents = {"a1": _agent("a1", "switchdev", "@everyone")}
        client, posted = _build_client(agents=agents, aliases={}, role_names=[])
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@switchdev @boss"), False
        )
        assert _MENTION.search(posted[0]) is None
        assert "switchdev" in posted[0]

    async def test_set_alias_display_name_cannot_forge_a_link(self) -> None:
        agents = {"a1": _agent("a1", "switchdev", "[here](https://example.invalid)")}
        client, posted = _build_client(agents=agents, aliases={}, role_names=[])
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@switchdev @boss"), False
        )
        assert "](https://example.invalid)" not in posted[0]

    async def test_set_alias_echoes_a_mistyped_token_verbatim(self) -> None:
        # The user typed the identifier, so the "no such agent" line has to
        # quote what they typed — not some other agent's display name.
        agents = {"a1": _agent("a1", "switchdev", "Switch Dev")}
        client, posted = _build_client(agents=agents, aliases={}, role_names=[])
        await _cmd_set_alias(
            client, _Room(room_id="!m:x"), _event("@switchdevv @boss"), False
        )
        assert "No agent named `switchdevv`" in posted[0]
        assert "Switch Dev" not in posted[0]

    async def test_list_aliases_names_the_agent_and_keeps_its_identifier(self) -> None:
        agents = {"a1": _agent("a1", "switchdev", "Switch Dev")}
        client, posted = _build_client(
            agents=agents, aliases={"a1": "boss"}, role_names=[]
        )
        await _cmd_list_aliases(client, _Room(room_id="!m:x"), _event(""), False)
        # The alias itself stays bare and typeable; the agent gets its label.
        assert "- `boss` → **Switch Dev (`switchdev`)**" in posted[0]

    async def test_list_aliases_without_a_display_name_names_it_once(self) -> None:
        client, posted = _build_client(
            agents=_AGENTS, aliases={"a1": "boss"}, role_names=[]
        )
        await _cmd_list_aliases(client, _Room(room_id="!m:x"), _event(""), False)
        assert "- `boss` → **claude-code.alice**" in posted[0]

    async def test_list_aliases_display_name_cannot_ping_the_channel(self) -> None:
        agents = {"a1": _agent("a1", "switchdev", "@everyone")}
        client, posted = _build_client(
            agents=agents, aliases={"a1": "boss"}, role_names=[]
        )
        await _cmd_list_aliases(client, _Room(room_id="!m:x"), _event(""), False)
        assert _MENTION.search(posted[0]) is None
        assert "switchdev" in posted[0]

    async def test_list_aliases_display_name_cannot_forge_a_link(self) -> None:
        agents = {"a1": _agent("a1", "switchdev", "[here](https://example.invalid)")}
        client, posted = _build_client(
            agents=agents, aliases={"a1": "boss"}, role_names=[]
        )
        await _cmd_list_aliases(client, _Room(room_id="!m:x"), _event(""), False)
        assert "](https://example.invalid)" not in posted[0]


class TestAliasCommandRegistration:
    def test_alias_commands_are_admin_owned(self) -> None:
        # The admin client owns and renders the alias commands; agents never
        # handle them, so no @agent/@alias token pulls another agent in.
        for name in ("set-alias", "remove-alias"):
            cmd = COMMANDS_BY_NAME[name]
            assert cmd.admin_owned is True
