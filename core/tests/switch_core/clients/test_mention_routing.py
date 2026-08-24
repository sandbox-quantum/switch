from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

from switch_core.bridges.agent.commands import _addressed_by_name_or_role
from switch_core.clients.agent_client import (
    AgentClient,
    _role_elsewhere_message,
)


def _no_connections() -> SimpleNamespace:
    """A connection registry with nothing live.

    Presence is the union of the heartbeat rows and the live connections
    (CHOO-1857); these tests drive the DB arm, so the connection arm must
    contribute nothing.
    """
    return SimpleNamespace(
        live_agent_ids=lambda: set(),
        is_live=lambda _agent_id: False,
        live_in_room=lambda _agent_id, _room_id: False,
        has_session_in=lambda _agent_id, _room_id: False,
        can_spawn_for=lambda _agent_id, _room_id: False,
        for_agent=lambda _agent_id: [],
    )


def _event(body: str, formatted_body: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(body=body, formatted_body=formatted_body)


def _client(name: str) -> SimpleNamespace:
    # Enough surface for the unbound _is_mentioned: an agent with a name and a
    # matrix_user_id for the formatted_body branch.
    return SimpleNamespace(
        agent=SimpleNamespace(name=name),
        matrix_user_id=f"@switch-agent-{name}:switch.local",
    )


def _is_mentioned(name: str, body: str) -> bool:
    return AgentClient._is_mentioned(_client(name), _event(body))


async def _command_addresses(name: str, args: str) -> bool:
    # Exercise the real default command-targeting predicate with a client that
    # holds no role, so this reflects pure name-boundary matching.
    client = SimpleNamespace(agent=SimpleNamespace(name=name))
    client._args_tag_my_name = lambda text: AgentClient._args_tag_my_name(client, text)

    async def _no(_text: str, _room_id: str) -> bool:
        return False

    client._text_tags_my_role = _no
    client._text_tags_my_alias = _no
    return await _addressed_by_name_or_role(client, args, "room-1")


class TestPrefixCollision:
    def test_mention_does_not_match_prefix_name(self) -> None:
        # The original bug: "@cc-bug-fixing" is a substring of "@cc-bug-fixing-2".
        assert _is_mentioned("cc-bug-fixing", "@cc-bug-fixing-2 please run") is False

    def test_mention_matches_exact_longer_name(self) -> None:
        assert _is_mentioned("cc-bug-fixing-2", "@cc-bug-fixing-2 please run") is True

    async def test_command_does_not_address_prefix_name(self) -> None:
        # `!run-cmd @cc-bug-fixing-2` must not trigger cc-bug-fixing.
        assert await _command_addresses("cc-bug-fixing", "@cc-bug-fixing-2") is False

    async def test_command_addresses_exact_name(self) -> None:
        assert await _command_addresses("cc-bug-fixing-2", "@cc-bug-fixing-2") is True

    def test_dotted_prefix_name_not_matched(self) -> None:
        full = "claude-code.workforce-manager.jdoe"
        prefix = "claude-code.workforce-manager"
        assert _is_mentioned(prefix, f"@{full} hi") is False
        assert _is_mentioned(full, f"@{full} hi") is True


class TestTruePositives:
    def test_trailing_space(self) -> None:
        assert _is_mentioned("cc-bug-fixing", "@cc-bug-fixing can you help") is True

    def test_end_of_string(self) -> None:
        assert _is_mentioned("cc-bug-fixing", "ping @cc-bug-fixing") is True

    def test_trailing_colon(self) -> None:
        assert _is_mentioned("cc-bug-fixing", "@cc-bug-fixing: status?") is True

    def test_case_insensitive(self) -> None:
        assert _is_mentioned("cc-bug-fixing", "@CC-Bug-Fixing hey") is True

    def test_no_at_means_not_mentioned(self) -> None:
        assert _is_mentioned("cc-bug-fixing", "cc-bug-fixing without an at") is False

    async def test_command_with_no_at_addresses_everyone(self) -> None:
        assert await _command_addresses("cc-bug-fixing", "") is True

    def test_formatted_body_full_mxid_still_matches(self) -> None:
        # The formatted_body branch matches the full Matrix id; unaffected by
        # the boundary fix.
        client = _client("cc-bug-fixing")
        event = _event(
            body="hello",
            formatted_body='<a href="...@switch-agent-cc-bug-fixing:switch.local">x</a>',
        )
        assert AgentClient._is_mentioned(client, event) is True


class TestMediaEventWithoutFormattedBody:
    """Media events (RoomMessageImage/File) have no `formatted_body` attribute.

    Regression: _is_mentioned used to read event.formatted_body directly and
    crashed with AttributeError on media events.
    """

    def test_media_caption_mention_matches(self) -> None:
        client = _client("cc-bug-fixing")
        # A media event surfaces only `body` (the caption) — no formatted_body.
        media_event = SimpleNamespace(body="@cc-bug-fixing look at this")
        assert AgentClient._is_mentioned(client, media_event) is True

    def test_media_without_mention_not_addressed(self) -> None:
        client = _client("cc-bug-fixing")
        media_event = SimpleNamespace(body="cat.png")
        assert AgentClient._is_mentioned(client, media_event) is False


class TestStripMention:
    def test_strips_exact_mention_only(self) -> None:
        client = _client("cc-bug-fixing")
        # Should strip its own mention...
        assert AgentClient._strip_mention(client, "@cc-bug-fixing hello").strip() == (
            "hello"
        )

    def test_does_not_strip_longer_name(self) -> None:
        client = _client("cc-bug-fixing")
        # ...but must not partially strip a longer agent's mention.
        assert (
            AgentClient._strip_mention(client, "@cc-bug-fixing-2 hello")
            == "@cc-bug-fixing-2 hello"
        )


def _role_client(agent_name: str, held_role: str | None) -> SimpleNamespace:
    """A fake client for role tagging: its agent LIVE-holds `held_role` (or
    None) — agent_room_role just returns that, ignoring the DB."""

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield object()

    async def _agent_room_role(_session, _room_id, _agent_id, _alive=()):  # type: ignore[no-untyped-def]
        return held_role

    return SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name=agent_name),
        session_factory=_session_factory,
        _connections=_no_connections(),
        _room_role_store=SimpleNamespace(agent_room_role=_agent_room_role),
    )


class TestRoleMentionRouting:
    """Tagging `@<role>` addresses an agent only if it LIVE-holds that role.

    `_is_mentioned_via_role` just unwraps `event.body` onto
    `_text_tags_my_role`, which is exercised directly here.
    """

    async def test_role_holder_is_addressed(self) -> None:
        client = _role_client("ephemeral-cc", held_role="manager")
        assert (
            await AgentClient._text_tags_my_role(client, "@manager review", "room-1")
            is True
        )

    async def test_non_holder_not_addressed(self) -> None:
        # This agent holds no role, so an @manager tag does not reach it.
        client = _role_client("ephemeral-cc", held_role=None)
        assert (
            await AgentClient._text_tags_my_role(client, "@manager review", "room-1")
            is False
        )

    async def test_other_role_tag_not_addressed(self) -> None:
        # Holds "worker" but "@manager" is tagged → not addressed.
        client = _role_client("ephemeral-cc", held_role="worker")
        assert (
            await AgentClient._text_tags_my_role(client, "@manager review", "room-1")
            is False
        )

    async def test_role_prefix_not_falsely_matched(self) -> None:
        # Boundary safety: holding "lead" must not match "@lead-dev".
        client = _role_client("ephemeral-cc", held_role="lead")
        assert (
            await AgentClient._text_tags_my_role(client, "@lead-dev ping", "room-1")
            is False
        )

    async def test_no_at_short_circuits(self) -> None:
        client = _role_client("ephemeral-cc", held_role="manager")
        assert (
            await AgentClient._text_tags_my_role(client, "no at here", "room-1")
            is False
        )


def _alias_client(agent_name: str, alias_by_room: dict[str, str]) -> SimpleNamespace:
    """A fake client whose room alias is looked up from `alias_by_room`
    (room_id -> alias), mirroring RoomStore.get_alias scoped per room."""

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield object()

    async def _get_alias(_session, room_id, _agent_id):  # type: ignore[no-untyped-def]
        return alias_by_room.get(room_id)

    return SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name=agent_name),
        session_factory=_session_factory,
        _connections=_no_connections(),
        _room_store=SimpleNamespace(get_alias=_get_alias),
    )


class TestAliasMentionRouting:
    """Tagging `@<alias>` addresses the agent exactly like its real name, and is
    scoped to the room the alias was set in. Exercises `_text_tags_my_alias`."""

    async def test_alias_addresses_agent(self) -> None:
        client = _alias_client("claude-code.aq-switch-2", {"room-1": "fixer"})
        assert (
            await AgentClient._text_tags_my_alias(
                client, "@fixer please look", "room-1"
            )
            is True
        )

    async def test_alias_case_insensitive(self) -> None:
        client = _alias_client("claude-code.aq-switch-2", {"room-1": "fixer"})
        assert (
            await AgentClient._text_tags_my_alias(client, "@FIXER hi", "room-1") is True
        )

    async def test_alias_is_room_scoped(self) -> None:
        # Alias set in room-1 only — tagging it in room-2 does not address us.
        client = _alias_client("claude-code.aq-switch-2", {"room-1": "fixer"})
        assert (
            await AgentClient._text_tags_my_alias(client, "@fixer hi", "room-2")
            is False
        )

    async def test_no_alias_not_addressed(self) -> None:
        client = _alias_client("claude-code.aq-switch-2", {})
        assert (
            await AgentClient._text_tags_my_alias(client, "@fixer hi", "room-1")
            is False
        )

    async def test_alias_prefix_not_falsely_matched(self) -> None:
        # Boundary safety: alias "fix" must not match "@fixer".
        client = _alias_client("claude-code.aq-switch-2", {"room-1": "fix"})
        assert (
            await AgentClient._text_tags_my_alias(client, "@fixer ping", "room-1")
            is False
        )

    async def test_no_at_short_circuits(self) -> None:
        client = _alias_client("claude-code.aq-switch-2", {"room-1": "fixer"})
        assert (
            await AgentClient._text_tags_my_alias(client, "no at here", "room-1")
            is False
        )


class TestCommandRoleTargeting:
    """`!run-cmd @<role>` / `!reset @<role>` target the role's holder.

    on_command lets an agent through when the command args tag a role it
    holds; that gate is `_text_tags_my_role(args, room_id)`.
    """

    async def test_holder_targeted_by_role(self) -> None:
        client = _role_client("ephemeral-cc", held_role="manager")
        assert (
            await AgentClient._text_tags_my_role(client, "@manager", "room-1") is True
        )

    async def test_non_holder_not_targeted(self) -> None:
        client = _role_client("ephemeral-cc", held_role=None)
        assert (
            await AgentClient._text_tags_my_role(client, "@manager", "room-1") is False
        )

    async def test_role_prefix_not_targeted(self) -> None:
        client = _role_client("ephemeral-cc", held_role="lead")
        assert (
            await AgentClient._text_tags_my_role(client, "@lead-dev", "room-1") is False
        )


def _unavailable_client(
    *,
    live_rooms: list[str],
    role_here: bool,
    connection_model: str = "session_addressable",
    bound_here: bool = False,
) -> SimpleNamespace:
    """Fake client for _reply_when_unavailable_here.

    `live_rooms`: room ids where the agent currently has a live, room-bound
    session (live_connected_rooms). `role_here`: whether the agent holds a live
    role in the room it was addressed from (agent_room_role). `connection_model`
    drives the dev-channels-warning branch; `bound_here` is what
    has_room_binding returns for the addressed room. `_unavailable_reply`
    returns the sentinel "OFFLINE".
    """

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield object()

    async def _live_connected_rooms(_session, _agent_id):  # type: ignore[no-untyped-def]
        return list(live_rooms)

    async def _agent_room_role(_session, _room_id, _agent_id, _alive=()):  # type: ignore[no-untyped-def]
        return "worker" if role_here else None

    async def _has_room_binding(_session, _agent_id, _room_id):  # type: ignore[no-untyped-def]
        return bound_here

    async def _unavailable_reply(  # type: ignore[no-untyped-def]
        _room_name,
        _agent,
        _asker_handle,
        other_room_names=None,
        connected_not_live=False,
    ):
        if other_room_names:
            return "ELSEWHERE: " + ", ".join(other_room_names)
        if connected_not_live:
            return "NOT_LIVE"
        return "OFFLINE"

    async def _get_room(_session, room_id):  # type: ignore[no-untyped-def]
        return SimpleNamespace(name=f"Room {room_id}")

    agent = SimpleNamespace(
        id="agent-1",
        integration_profile={"connection_model": connection_model},
    )

    async def _fresh_agent():  # type: ignore[no-untyped-def]
        return agent

    return SimpleNamespace(
        agent=agent,
        _fresh_agent=_fresh_agent,
        session_factory=_session_factory,
        _connections=_no_connections(),
        _room_role_store=SimpleNamespace(agent_room_role=_agent_room_role),
        _agent_session_store=SimpleNamespace(
            live_connected_rooms=_live_connected_rooms,
            has_room_binding=_has_room_binding,
        ),
        _room_store=SimpleNamespace(get=_get_room),
        _unavailable_reply=_unavailable_reply,
    )


def _here() -> SimpleNamespace:
    return SimpleNamespace(room_id="room-A", name="Room A")


class TestUnavailableHereReply:
    """An agent addressed in room A while its session is elsewhere should say
    where it actually is, not the generic 'no active session'."""

    async def test_role_holder_session_elsewhere_says_role_elsewhere(self) -> None:
        # Holds a role here, but its assuming session is attending room-B.
        client = _unavailable_client(live_rooms=["room-B"], role_here=True)
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == _role_elsewhere_message("Room room-B")
        assert "Room room-B" in msg

    async def test_no_role_lists_other_sessions(self) -> None:
        # No role here, but the agent has live sessions in two other rooms.
        # Defers to the known-agent reply (paste-ready connect command) with
        # the other rooms threaded in, rather than the role-flavoured wording.
        client = _unavailable_client(live_rooms=["room-B", "room-C"], role_here=False)
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == "ELSEWHERE: Room room-B, Room room-C"

    async def test_only_session_is_here_falls_back_to_offline(self) -> None:
        # The only live session is the addressed room itself → nothing elsewhere.
        client = _unavailable_client(live_rooms=["room-A"], role_here=False)
        assert (
            await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
            == "OFFLINE"
        )

    async def test_no_live_sessions_is_offline(self) -> None:
        client = _unavailable_client(live_rooms=[], role_here=False)
        assert (
            await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
            == "OFFLINE"
        )


class TestConnectedNotLive:
    """A session_addressable agent with a session bound here but not live (and
    no live session in a distinct room) gets the connected-not-live reply."""

    async def test_bound_but_not_live_says_connected_not_live(self) -> None:
        client = _unavailable_client(live_rooms=[], role_here=False, bound_here=True)
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == "NOT_LIVE"

    async def test_no_binding_is_offline(self) -> None:
        client = _unavailable_client(live_rooms=[], role_here=False, bound_here=False)
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == "OFFLINE"

    async def test_passive_never_says_connected_not_live(self) -> None:
        # session_passive has no dev-channels flag; this branch must not apply.
        client = _unavailable_client(
            live_rooms=[],
            role_here=False,
            connection_model="session_passive",
            bound_here=True,
        )
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == "OFFLINE"

    async def test_same_named_live_room_not_offered_as_elsewhere(self) -> None:
        # The reported bug: a live session in a DIFFERENT room that shows the
        # same name as this one must not be offered as "elsewhere". Bound here +
        # not live → connected-not-live, not a confusing same-name pointer.
        # _here() is room-A / "Room A"; room id "A" → name "Room A" (collision).
        client = _unavailable_client(live_rooms=["A"], role_here=False, bound_here=True)
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == "NOT_LIVE"

    async def test_distinct_named_live_room_still_points_elsewhere(self) -> None:
        # A genuinely different (distinct-named) live room still wins.
        client = _unavailable_client(
            live_rooms=["room-B"], role_here=False, bound_here=True
        )
        msg = await AgentClient._reply_when_unavailable_here(client, _here(), "asker")
        assert msg == "ELSEWHERE: Room room-B"
