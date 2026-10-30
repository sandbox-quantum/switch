"""`!link-account` and `!unlink-account`: a chat account's own say over its
links to Switch users (CHOO-3881).

Run against real Postgres with real stores: who sent a command is the whole
point, and it is decided by which chat account's client the message came
from, never by anything in the message.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import _cmd_link_account, _cmd_unlink_account
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    TenantMember,
    User,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore

_ROOM = SimpleNamespace(room_id="!room:test")
_STORE = ExternalUserStore()


@dataclass
class _World:
    host: CommandConsumer
    replies: list[str]
    session_factory: async_sessionmaker[AsyncSession]
    ada: str
    bob: str
    ada_account: ExternalUser
    ada_chat: str
    bystander_chat: str
    member_chat: str


async def _user(session: AsyncSession, name: str) -> str:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"))
    await session.flush()
    return user.id


async def _account(
    session: AsyncSession, bridge_id: str, name: str
) -> tuple[ExternalUser, str]:
    client = Client(
        transport_user_id=f"@chat-{name}:test", display_name=name, type="user"
    )
    session.add(client)
    await session.flush()
    account = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U-{name}",
        external_username=name,
        client_id=client.id,
    )
    session.add(account)
    await session.flush()
    return account, client.transport_user_id


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    async with session_factory() as session:
        bridge_client = Client(
            transport_user_id="@bridge:test", display_name="bridge", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Acme Slack",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        ada = await _user(session, "ada")
        bob = await _user(session, "bob")
        ada_account, ada_chat = await _account(session, bridge.id, "ada")
        _bystander, bystander_chat = await _account(session, bridge.id, "bystander")
        # Ada speaking in Console: a gateway member, not a chat account.
        member = Client(
            transport_user_id="@member-ada:test",
            display_name="ada",
            type="member",
            user_id=ada,
        )
        session.add(member)
        await session.commit()

    replies: list[str] = []

    async def reply_command(_room_id: str, body: str, **_kw: Any) -> None:
        replies.append(body)

    host = object.__new__(CommandConsumer)
    host.actor = SimpleNamespace(  # type: ignore[assignment]
        session_factory=session_factory, client_store=ClientStore()
    )
    host._external_user_store = ExternalUserStore()
    host._user_store = UserStore()
    host.reply_command = reply_command  # type: ignore[method-assign]
    return _World(
        host=host,
        replies=replies,
        session_factory=session_factory,
        ada=ada,
        bob=bob,
        ada_account=ada_account,
        ada_chat=ada_chat,
        bystander_chat=bystander_chat,
        member_chat=member.transport_user_id,
    )


def _event(command: str, args: str, sender: str) -> Any:
    return SimpleNamespace(
        command=command, args=args, user_id=sender, user_name="someone", thread_id="t1"
    )


async def _link(world: _World, args: str, sender: str) -> None:
    await _cmd_link_account(
        world.host,  # type: ignore[arg-type]
        _ROOM,  # type: ignore[arg-type]
        _event("link-account", args, sender),
        False,
    )


async def _unlink(world: _World, args: str, sender: str) -> None:
    await _cmd_unlink_account(
        world.host,  # type: ignore[arg-type]
        _ROOM,  # type: ignore[arg-type]
        _event("unlink-account", args, sender),
        False,
    )


async def _code_for(world: _World, user_id: str) -> str:
    async with world.session_factory() as session:
        request = await _STORE.request_link(
            session, world.ada_account, user_id, requested_by_user_id=user_id
        )
        code, _expires = await _STORE.issue_link_code(session, request)
        await session.commit()
    return code


async def _claimants(world: _World) -> list[str]:
    async with world.session_factory() as session:
        return sorted(await _STORE.claimant_ids(session, world.ada_account.id))


class TestLinkAccount:
    async def test_the_code_from_the_account_links_it_and_says_to_whom(
        self, world: _World
    ) -> None:
        code = await _code_for(world, world.ada)

        await _link(world, code, world.ada_chat)

        assert await _claimants(world) == [world.ada]
        assert len(world.replies) == 1
        assert "**ada**" in world.replies[0]
        assert "Acme Slack" in world.replies[0]
        assert "`unlink-account ada` the way you ran this command" in world.replies[0]
        async with world.session_factory() as session:
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.BRIDGE_IDENTITY_CLAIMED
                )
            )
            assert event is not None
            assert event.actor_user_id == world.ada
            assert event.details["by"] == "code"

    async def test_the_code_from_another_account_links_nothing(
        self, world: _World
    ) -> None:
        code = await _code_for(world, world.ada)

        await _link(world, code, world.bystander_chat)

        assert await _claimants(world) == []
        assert world.replies[0].startswith("⚠️")

    async def test_a_message_from_console_cannot_confirm(self, world: _World) -> None:
        # The member client is Ada herself, but it is no chat account: the
        # platform has said nothing about who holds the Slack account.
        code = await _code_for(world, world.ada)

        await _link(world, code, world.member_chat)

        assert await _claimants(world) == []
        assert "Only a chat account" in world.replies[0]

    async def test_a_wrong_code_links_nothing(self, world: _World) -> None:
        await _code_for(world, world.ada)

        await _link(world, "ABCD-EFGH", world.ada_chat)

        assert await _claimants(world) == []
        assert "doesn't match" in world.replies[0]

    async def test_no_code_gets_the_usage(self, world: _World) -> None:
        await _link(world, "  ", world.ada_chat)

        assert world.replies[0].startswith("Usage:")


class TestUnlinkAccount:
    async def _link_both(self, world: _World) -> None:
        async with world.session_factory() as session:
            session.add(
                ExternalUserClaim(
                    external_user_id=world.ada_account.id, user_id=world.bob
                )
            )
            await session.commit()
        await _link(world, await _code_for(world, world.ada), world.ada_chat)
        world.replies.clear()

    async def test_without_a_name_it_lists_the_links(self, world: _World) -> None:
        await self._link_both(world)

        await _unlink(world, "", world.ada_chat)

        assert "- **ada**\n" in world.replies[0]
        assert "- **bob** (made before links needed confirming)" in world.replies[0]

    async def test_it_removes_only_the_named_link(self, world: _World) -> None:
        await self._link_both(world)

        await _unlink(world, "bob", world.ada_chat)

        assert await _claimants(world) == [world.ada]
        assert world.replies[0] == "Unlinked this account from Switch user **bob**."
        async with world.session_factory() as session:
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.BRIDGE_IDENTITY_RELEASED
                )
            )
            assert event is not None
            assert event.actor_user_id is None
            assert event.details == {
                "bridge_id": world.ada_account.bridge_id,
                "user_id": world.bob,
                "by": "chat_account",
            }

    async def test_a_link_can_be_named_by_email(self, world: _World) -> None:
        await self._link_both(world)

        await _unlink(world, "BOB@test", world.ada_chat)

        assert await _claimants(world) == [world.ada]

    async def test_another_account_cannot_unlink_it(self, world: _World) -> None:
        await self._link_both(world)

        await _unlink(world, "bob", world.bystander_chat)

        assert await _claimants(world) == sorted([world.ada, world.bob])
        assert "isn't linked to a Switch user called" in world.replies[0]

    async def test_an_unknown_name_says_what_it_is_linked_to(
        self, world: _World
    ) -> None:
        await self._link_both(world)

        await _unlink(world, "carol", world.ada_chat)

        assert await _claimants(world) == sorted([world.ada, world.bob])
        assert "**carol**" in world.replies[0]
        assert "- **bob**" in world.replies[0]

    async def test_a_message_from_console_cannot_unlink(self, world: _World) -> None:
        await self._link_both(world)

        await _unlink(world, "bob", world.member_chat)

        assert await _claimants(world) == sorted([world.ada, world.bob])
        assert "Only a chat account" in world.replies[0]
