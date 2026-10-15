"""`!rename-agent` and `!delete-agent`: renaming and deleting an agent from a
bridged chat.

Run against real Postgres with real stores for everything that decides who
may act: the sender is a person on a chat platform, known to Switch only
through the Switch users who linked that account, and only the agent's owner
or a workspace admin may rename or delete it. The rename and delete
themselves are AgentCore's, covered in their own tests; here they are faked
so each test can say exactly what the command asked for.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    _cmd_delete_agent,
    _cmd_rename_agent,
)
from switch_core.bridges.agent.protocol.agent_core import (
    AgentDeletionResult,
    AgentExistsError,
    AgentRenameRefused,
    AgentRenameResult,
)
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_service,
    register,
)

_ROOM = SimpleNamespace(room_id="!room:test")


@dataclass
class _FakeCore:
    rename_error: Exception | None = None
    bridge_failures: list[str] = field(default_factory=list)
    templates: list[str] = field(default_factory=list)
    renamed: list[dict[str, Any]] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)

    async def rename_agent(
        self, *, agent_id: str, new_name: str, display_name: str | None
    ) -> AgentRenameResult:
        self.renamed.append(
            {"agent_id": agent_id, "new_name": new_name, "display_name": display_name}
        )
        if self.rename_error is not None:
            raise self.rename_error
        return AgentRenameResult(
            agent_id=agent_id,
            old_name="notes-taker",
            new_name=new_name,
            display_name=display_name,
            bridge_failures=self.bridge_failures,
            templates_mentioning_old_name=self.templates,
        )

    async def delete_agent(self, *, agent_id: str) -> AgentDeletionResult:
        self.deleted.append(agent_id)
        return AgentDeletionResult(bridge_failures=self.bridge_failures)


@dataclass
class _World:
    host: CommandConsumer
    core: _FakeCore
    replies: list[str]
    agent_id: str
    owner_chat: str
    stranger_chat: str
    admin_chat: str
    unlinked_chat: str
    agent_chat: str


async def _bridge(session: AsyncSession) -> str:
    client = Client(
        transport_user_id="@bridge:test", display_name="bridge", type="bridge"
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="mattermost",
        display_name="MM",
        client_id=client.id,
        status="active",
        channel_creation_enabled=True,
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _person(
    session: AsyncSession,
    bridge_id: str,
    name: str,
    *,
    claimed_by: str | None,
) -> str:
    """A person on a chat platform: their client, their platform identity, and
    (optionally) the Switch user who linked it. Returns their transport id."""
    client = Client(
        transport_user_id=f"@chat-{name}:test", display_name=name, type="user"
    )
    session.add(client)
    await session.flush()
    external = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U-{name}",
        external_username=name,
        client_id=client.id,
    )
    session.add(external)
    await session.flush()
    if claimed_by is not None:
        session.add(ExternalUserClaim(external_user_id=external.id, user_id=claimed_by))
    return client.transport_user_id


async def _user(session: AsyncSession, name: str, *, role: str | None) -> str:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    if role is not None:
        session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role))
    return user.id


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    async with session_factory() as session:
        owner = await _user(session, "owner", role="member")
        stranger = await _user(session, "stranger", role="member")
        admin = await _user(session, "admin", role="admin")
        bridge_id = await _bridge(session)
        owner_chat = await _person(session, bridge_id, "owner", claimed_by=owner)
        stranger_chat = await _person(
            session, bridge_id, "stranger", claimed_by=stranger
        )
        admin_chat = await _person(session, bridge_id, "admin", claimed_by=admin)
        unlinked_chat = await _person(session, bridge_id, "unlinked", claimed_by=None)
        await session.commit()

    svc = make_service(session_factory)
    agent_id = await register(svc, "notes-taker", owner, display_name="Notes Taker")
    other_agent_id = await register(svc, "helper", owner)
    async with session_factory() as session:
        other = await AgentStore().get(session, other_agent_id)
        assert other is not None
        helper_client = await session.get(Client, other.client_id)
        assert helper_client is not None
        agent_chat = helper_client.transport_user_id

    core = _FakeCore()
    replies: list[str] = []

    async def reply_command(_room_id: str, body: str, **_kw: Any) -> None:
        replies.append(body)

    host = object.__new__(CommandConsumer)
    host.actor = SimpleNamespace(  # type: ignore[assignment]
        session_factory=session_factory, client_store=ClientStore()
    )
    host._agent_store = AgentStore()
    host._external_user_store = ExternalUserStore()
    host._user_store = UserStore()
    host._agent_admin = SimpleNamespace(core=core)  # type: ignore[assignment]
    host._pending_deletes = {}
    host.reply_command = reply_command  # type: ignore[method-assign]
    return _World(
        host=host,
        core=core,
        replies=replies,
        agent_id=agent_id,
        owner_chat=owner_chat,
        stranger_chat=stranger_chat,
        admin_chat=admin_chat,
        unlinked_chat=unlinked_chat,
        agent_chat=agent_chat,
    )


def _event(command: str, args: str, sender: str) -> Any:
    return SimpleNamespace(
        command=command, args=args, user_id=sender, user_name="someone", thread_id="t1"
    )


async def _rename(world: _World, args: str, sender: str) -> None:
    await _cmd_rename_agent(
        world.host,  # type: ignore[arg-type]
        _ROOM,  # type: ignore[arg-type]
        _event("rename-agent", args, sender),
        False,
    )


async def _delete(world: _World, args: str, sender: str) -> None:
    await _cmd_delete_agent(
        world.host,  # type: ignore[arg-type]
        _ROOM,  # type: ignore[arg-type]
        _event("delete-agent", args, sender),
        False,
    )


class TestRenameCommand:
    async def test_the_owner_renames_and_the_label_follows(self, world: _World) -> None:
        await _rename(world, "@notes-taker meeting-scribe", world.owner_chat)

        assert world.core.renamed == [
            {
                "agent_id": world.agent_id,
                "new_name": "meeting-scribe",
                "display_name": "Meeting Scribe",
            }
        ]
        assert "Renamed `notes-taker`" in world.replies[0]
        assert "Meeting Scribe" in world.replies[0]

    async def test_a_given_display_name_is_used_as_written(self, world: _World) -> None:
        await _rename(
            world, '@notes-taker meeting-scribe "The Scribe"', world.owner_chat
        )

        assert world.core.renamed[0]["display_name"] == "The Scribe"

    async def test_an_unquoted_display_name_with_spaces_works(
        self, world: _World
    ) -> None:
        await _rename(world, "@notes-taker meeting-scribe The Scribe", world.owner_chat)

        assert world.core.renamed[0]["display_name"] == "The Scribe"

    async def test_the_new_name_may_be_written_with_an_at(self, world: _World) -> None:
        """Discord's slash form sends every name argument with a leading `@`."""
        await _rename(world, "@notes-taker @meeting-scribe", world.owner_chat)

        assert world.core.renamed[0]["new_name"] == "meeting-scribe"

    async def test_an_admin_may_rename_someone_elses_agent(self, world: _World) -> None:
        await _rename(world, "@notes-taker meeting-scribe", world.admin_chat)

        assert len(world.core.renamed) == 1

    async def test_someone_else_is_refused(self, world: _World) -> None:
        await _rename(world, "@notes-taker hijacked", world.stranger_chat)

        assert world.core.renamed == []
        assert "Only the agent's owner or a workspace admin" in world.replies[0]

    async def test_an_unlinked_chat_account_is_told_how_to_link(
        self, world: _World
    ) -> None:
        await _rename(world, "@notes-taker hijacked", world.unlinked_chat)

        assert world.core.renamed == []
        assert "isn't linked to a Switch user" in world.replies[0]

    async def test_an_agent_cannot_run_it(self, world: _World) -> None:
        await _rename(world, "@notes-taker hijacked", world.agent_chat)

        assert world.core.renamed == []
        assert "Only a person" in world.replies[0]

    async def test_an_unknown_agent(self, world: _World) -> None:
        await _rename(world, "@nobody something", world.owner_chat)

        assert world.core.renamed == []
        assert "No agent named `nobody`" in world.replies[0]

    async def test_missing_arguments_show_usage(self, world: _World) -> None:
        await _rename(world, "@notes-taker", world.owner_chat)

        assert world.core.renamed == []
        assert world.replies[0].startswith("Usage:")

    @pytest.mark.parametrize(
        "error",
        [
            AgentExistsError("Agent already exists: 'helper'."),
            AgentRenameRefused("'manager' is the name of a role in room 'ops'."),
            ValueError("Invalid agent name: 'Bad Name'."),
        ],
    )
    async def test_a_refused_rename_says_why(
        self, world: _World, error: Exception
    ) -> None:
        world.core.rename_error = error

        await _rename(world, "@notes-taker whatever", world.owner_chat)

        assert world.replies[0] == f"⚠️ Not renamed: {error}"

    async def test_platforms_left_behind_and_templates_are_reported(
        self, world: _World
    ) -> None:
        world.core.bridge_failures = ["slack: Slack is down"]
        world.core.templates = ["weekly"]

        await _rename(world, "@notes-taker meeting-scribe", world.owner_chat)

        assert "slack: Slack is down" in world.replies[0]
        assert "`weekly`" in world.replies[0]

    async def test_the_reply_carries_no_live_mention(self, world: _World) -> None:
        """A live `@name` in the result would address the agent it names."""
        await _rename(world, "@notes-taker meeting-scribe", world.owner_chat)

        assert "@meeting-scribe" not in world.replies[0]
        assert "@notes-taker" not in world.replies[0]


class TestDeleteCommand:
    async def test_the_first_ask_only_asks_for_confirmation(
        self, world: _World
    ) -> None:
        await _delete(world, "@notes-taker", world.owner_chat)

        assert world.core.deleted == []
        assert "!delete-agent notes-taker confirm" in world.replies[0]

    async def test_confirming_deletes(self, world: _World) -> None:
        await _delete(world, "@notes-taker", world.owner_chat)
        await _delete(world, "@notes-taker confirm", world.owner_chat)

        assert world.core.deleted == [world.agent_id]
        assert world.replies[1].startswith("Deleted **Notes Taker")

    async def test_confirm_without_asking_first_only_asks(self, world: _World) -> None:
        await _delete(world, "@notes-taker confirm", world.owner_chat)

        assert world.core.deleted == []
        assert "To go ahead" in world.replies[0]

    async def test_someone_elses_ask_does_not_count(self, world: _World) -> None:
        await _delete(world, "@notes-taker", world.admin_chat)
        await _delete(world, "@notes-taker confirm", world.owner_chat)

        assert world.core.deleted == []

    async def test_a_lapsed_ask_does_not_count(
        self, world: _World, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        await _delete(world, "@notes-taker", world.owner_chat)
        monkeypatch.setattr(
            "switch_core.clients.command_consumer.DELETE_CONFIRM_SECONDS", 0.0
        )
        world.host._pending_deletes = {key: 0.0 for key in world.host._pending_deletes}
        await _delete(world, "@notes-taker confirm", world.owner_chat)

        assert world.core.deleted == []

    async def test_a_confirmation_is_used_once(self, world: _World) -> None:
        await _delete(world, "@notes-taker", world.owner_chat)
        await _delete(world, "@notes-taker confirm", world.owner_chat)
        await _delete(world, "@notes-taker confirm", world.owner_chat)

        assert world.core.deleted == [world.agent_id]

    async def test_someone_else_is_refused(self, world: _World) -> None:
        await _delete(world, "@notes-taker", world.stranger_chat)
        await _delete(world, "@notes-taker confirm", world.stranger_chat)

        assert world.core.deleted == []
        assert all("Only the agent's owner" in reply for reply in world.replies)

    async def test_a_failed_clean_up_is_reported(self, world: _World) -> None:
        world.core.bridge_failures = ["slack: Slack is down"]

        await _delete(world, "@notes-taker", world.owner_chat)
        await _delete(world, "@notes-taker confirm", world.owner_chat)

        assert "slack: Slack is down" in world.replies[1]


class TestRegistration:
    @pytest.mark.parametrize("name", ["rename-agent", "delete-agent"])
    def test_the_admin_client_owns_it(self, name: str) -> None:
        command = COMMANDS_BY_NAME[name]
        assert command.admin_owned
        assert not command.hidden

    def test_rename_declares_its_display_name_as_free_text(self) -> None:
        spec = COMMANDS_BY_NAME["rename-agent"].args_spec
        assert [arg.name for arg in spec] == ["agent", "new_name", "display_name"]
        assert spec[-1].free_text and not spec[-1].required
