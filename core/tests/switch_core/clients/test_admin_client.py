from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

from switch_core.bridges.agent.commands import dispatch_admin_command
from switch_core.clients.admin_client import AdminClient
from switch_core.clients.admin_messages import ADMIN_MARKER, AdminMessageType
from switch_core.events import CommandEvent
from switch_core.transport import InboundMessage, RoomRef


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


def _event(body: str, sender_name: str = "alice") -> InboundMessage:
    """A room message as the admin client sees it: body + sender + the
    bridge-provided sender_name in content (used to tag the asker)."""
    return InboundMessage(
        room_id="!matrix:switch.local",
        event_id="$evt",
        sender=f"@{sender_name}:switch.local",
        timestamp=1700000000000,
        content={"sender_name": sender_name},
        body=body,
        sender_name=sender_name,
    )


def _room() -> RoomRef:
    return RoomRef(room_id="!matrix:switch.local")


def _admin_client(
    *,
    members: set[str] | None = None,
    agents_by_name: dict[str, SimpleNamespace] | None = None,
    roles: list[SimpleNamespace] | None = None,
    live_role_ids: set[str] | None = None,
) -> tuple[SimpleNamespace, list[dict[str, object]]]:
    """Fake AdminClient surface for the warning methods.

    `members`: agent ids in the room. `agents_by_name`: registered agents keyed
    by lowercased name (the case-insensitive resolver). `roles`: defined room
    roles. `live_role_ids`: roles with a LIVE holder. Returns (client, sent)
    where each `sent` entry captures the admin message that was posted.
    """
    members = members or set()
    agents_by_name = agents_by_name or {}
    roles = roles or []
    live_role_ids = live_role_ids or set()
    sent: list[dict[str, object]] = []

    @asynccontextmanager
    async def _session_factory():  # type: ignore[no-untyped-def]
        yield object()

    async def _get_agent_ids(_session, _room_id):  # type: ignore[no-untyped-def]
        return list(members)

    async def _list_roles(_session, _room_id):  # type: ignore[no-untyped-def]
        return roles

    async def _has_live_holder(_session, role_id, _alive=()):  # type: ignore[no-untyped-def]
        return role_id in live_role_ids

    async def _get_by_name_insensitive(_session, name):  # type: ignore[no-untyped-def]
        return agents_by_name.get(name.lower())

    async def _send_message(  # type: ignore[no-untyped-def]
        room_id,
        body,
        *,
        format="markdown",
        mentions=None,
        thread_root_id=None,
        extra_content=None,
    ):
        sent.append(
            {
                "body": body,
                "thread_root_id": thread_root_id,
                "mentions": mentions,
                "extra_content": extra_content,
            }
        )

    client = SimpleNamespace(
        session_factory=_session_factory,
        _connections=_no_connections(),
        send_message=_send_message,
        _room_store=SimpleNamespace(get_agent_ids=_get_agent_ids),
        _room_role_store=SimpleNamespace(
            list_roles=_list_roles,
            has_live_holder=_has_live_holder,
        ),
        _agent_store=SimpleNamespace(get_by_name_insensitive=_get_by_name_insensitive),
    )
    client._send_admin = lambda *a, **k: AdminClient._send_admin(client, *a, **k)
    client._sender_handle = lambda event: AdminClient._sender_handle(client, event)
    return client, sent


def _marker_type(entry: dict[str, object]) -> object:
    extra = entry["extra_content"]
    assert isinstance(extra, dict)
    return extra[ADMIN_MARKER]["type"]  # type: ignore[index]


class TestAdminUnreachableRoleWarning:
    async def test_warns_when_no_live_holder(self) -> None:
        roles = [SimpleNamespace(id="r-mgr", name="manager")]
        client, sent = _admin_client(roles=roles, live_role_ids=set())
        event = _event("@manager please review")
        await AdminClient._warn_unreachable_roles(
            client, _room(), event, "room-1", None
        )
        assert len(sent) == 1
        assert "currently holds the **manager** role" in sent[0]["body"]
        assert _marker_type(sent[0]) == AdminMessageType.UNREACHABLE_ROLE.value

    async def test_warning_tags_the_asker(self) -> None:
        roles = [SimpleNamespace(id="r-mgr", name="manager")]
        client, sent = _admin_client(roles=roles, live_role_ids=set())
        event = _event("@manager review?", sender_name="bob")
        await AdminClient._warn_unreachable_roles(
            client, _room(), event, "room-1", None
        )
        assert "@bob" in sent[0]["body"]
        assert sent[0]["mentions"] == ["@bob:switch.local"]

    async def test_warning_threads_under_trigger(self) -> None:
        roles = [SimpleNamespace(id="r-mgr", name="manager")]
        client, sent = _admin_client(roles=roles, live_role_ids=set())
        event = _event("@manager please review")
        await AdminClient._warn_unreachable_roles(
            client, _room(), event, "room-1", "thread-42"
        )
        assert sent[0]["thread_root_id"] == "thread-42"

    async def test_no_warning_when_holder_live(self) -> None:
        roles = [SimpleNamespace(id="r-mgr", name="manager")]
        client, sent = _admin_client(roles=roles, live_role_ids={"r-mgr"})
        event = _event("@manager status?")
        await AdminClient._warn_unreachable_roles(
            client, _room(), event, "room-1", None
        )
        assert sent == []

    async def test_no_warning_when_role_not_tagged(self) -> None:
        roles = [SimpleNamespace(id="r-mgr", name="manager")]
        client, sent = _admin_client(roles=roles, live_role_ids=set())
        event = _event("just chatting, no tags")
        await AdminClient._warn_unreachable_roles(
            client, _room(), event, "room-1", None
        )
        assert sent == []

    async def test_prefix_role_not_falsely_warned(self) -> None:
        roles = [SimpleNamespace(id="r-lead", name="lead")]
        client, sent = _admin_client(roles=roles, live_role_ids=set())
        event = _event("@lead-dev ping")
        await AdminClient._warn_unreachable_roles(
            client, _room(), event, "room-1", None
        )
        assert sent == []


class TestAdminAbsentAgentWarning:
    async def test_warns_when_agent_absent(self) -> None:
        agents = {"web-searcher": SimpleNamespace(id="a-web", name="web-searcher")}
        client, sent = _admin_client(agents_by_name=agents)
        event = _event("@web-searcher can you look this up?")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert len(sent) == 1
        assert "web-searcher" in sent[0]["body"]
        assert "isn't in this room" in sent[0]["body"]
        assert _marker_type(sent[0]) == AdminMessageType.ABSENT_AGENT.value

    async def test_warning_tags_the_asker(self) -> None:
        agents = {"web-searcher": SimpleNamespace(id="a-web", name="web-searcher")}
        client, sent = _admin_client(agents_by_name=agents)
        event = _event("@web-searcher ping", sender_name="carol")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert "@carol" in sent[0]["body"]
        assert sent[0]["mentions"] == ["@carol:switch.local"]

    async def test_warning_threads_under_trigger(self) -> None:
        agents = {"web-searcher": SimpleNamespace(id="a-web", name="web-searcher")}
        client, sent = _admin_client(agents_by_name=agents)
        event = _event("@web-searcher ping")
        await AdminClient._warn_absent_agents(
            client, _room(), event, "room-1", "thread-42"
        )
        assert sent[0]["thread_root_id"] == "thread-42"

    async def test_no_warning_when_agent_is_member(self) -> None:
        agents = {"web-searcher": SimpleNamespace(id="a-web", name="web-searcher")}
        client, sent = _admin_client(members={"a-web"}, agents_by_name=agents)
        event = _event("@web-searcher status?")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert sent == []

    async def test_no_warning_for_unknown_token(self) -> None:
        # A human user or a typo resolves to no agent — stay silent.
        client, sent = _admin_client(agents_by_name={})
        event = _event("@dave what do you think?")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert sent == []

    async def test_prefix_name_not_falsely_warned(self) -> None:
        agents = {"cc-bug-fixing": SimpleNamespace(id="a-ccbf", name="cc-bug-fixing")}
        client, sent = _admin_client(agents_by_name=agents)
        event = _event("@cc-bug-fixing-2 please run")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert sent == []

    async def test_role_token_skipped(self) -> None:
        # A tagged role is left to _warn_unreachable_roles, not double-flagged.
        roles = [SimpleNamespace(id="r-mgr", name="manager")]
        client, sent = _admin_client(agents_by_name={}, roles=roles)
        event = _event("@manager please review")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert sent == []

    async def test_combines_multiple_absent_agents(self) -> None:
        agents = {
            "web-searcher": SimpleNamespace(id="a-web", name="web-searcher"),
            "doc-expert": SimpleNamespace(id="a-doc", name="doc-expert"),
        }
        client, sent = _admin_client(agents_by_name=agents)
        event = _event("@web-searcher @doc-expert can you pair up?")
        await AdminClient._warn_absent_agents(client, _room(), event, "room-1", None)
        assert len(sent) == 1
        assert "web-searcher" in sent[0]["body"]
        assert "doc-expert" in sent[0]["body"]
        assert "aren't in this room" in sent[0]["body"]


def _cmd_event(command: str, args: str = "") -> CommandEvent:
    return CommandEvent(
        command=command,
        args=args,
        user_id="u1",
        user_name="louisa",
        thread_id="$cmd",
    )


def _command_host() -> tuple[SimpleNamespace, list[dict[str, object]]]:
    sent: list[dict[str, object]] = []

    async def _reply_command(  # type: ignore[no-untyped-def]
        room_id, body, *, format="markdown", thread_root_id=None
    ):
        sent.append({"body": body, "thread_root_id": thread_root_id})

    async def _is_direct_room(_matrix_room_id: str) -> bool:
        return False

    host = SimpleNamespace(
        reply_command=_reply_command,
        _is_direct_room=_is_direct_room,
    )
    return host, sent


class TestAdminCommandDispatch:
    async def test_reply_command_is_marked_as_command_result(self) -> None:
        client, sent = _admin_client()
        client.reply_command = lambda *a, **k: AdminClient.reply_command(
            client, *a, **k
        )
        await client.reply_command("!m", "the result")
        assert sent[0]["body"] == "the result"
        assert _marker_type(sent[0]) == AdminMessageType.COMMAND_RESULT.value

    async def test_admin_owned_command_is_handled(self) -> None:
        host, sent = _command_host()
        await dispatch_admin_command(host, _room(), _cmd_event("help"))
        assert len(sent) == 1
        assert sent[0]["body"].startswith("**Available commands:**")

    async def test_agent_owned_command_is_ignored(self) -> None:
        # run-cmd is agent-owned — the admin client must not respond to it.
        host, sent = _command_host()
        await dispatch_admin_command(host, _room(), _cmd_event("run-cmd", "@agent"))
        assert sent == []

    async def test_unknown_command_gets_a_notice(self) -> None:
        host, sent = _command_host()
        await dispatch_admin_command(host, _room(), _cmd_event("bogus"))
        assert len(sent) == 1
        assert "Unknown command" in sent[0]["body"]
