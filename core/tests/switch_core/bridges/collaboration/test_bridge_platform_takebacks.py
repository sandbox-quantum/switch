"""What the bridge does when a platform takes something back: a post deleted
or edited, a channel deleted or archived. Against real Postgres, so the rows
that go are the rows that were there."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import (
    InboundChannelRemoved,
    InboundMessageDeleted,
    InboundMessageEdited,
)
from switch_core.db.models import (
    BridgeMessageMap,
    Client,
    CollaborationBridge,
    ExternalUser,
    Message,
    Room,
)
from switch_core.db.stores.message_store import MessageStore
from switch_core.retention.platform_deletes import PlatformDeletions
from switch_core.transport.content import EDITED_AT_KEY
from switch_core.trust.client import NullTrustClient, TrustCheckResult

CHANNEL = "C-takeback"


class _Adapter:
    platform_name = "Slack"

    def translate_inbound(self, raw: str) -> str:
        return raw.replace("<@U1>", "@alice")


class _RoomService:
    def __init__(self) -> None:
        self.unlinked: list[str] = []
        self.changed: list[tuple[str, str]] = []

    async def unlink_bridge_from_room(self, room_id: str) -> None:
        self.unlinked.append(room_id)

    def room_changed(self, tenant_id: str, room_id: str) -> None:
        self.changed.append((tenant_id, room_id))


class _Blocking:
    async def check(self, *, role: str, content: str, room_id: str) -> Any:
        return TrustCheckResult(outcome="blocked", policy_id="p", policy_name="P")

    async def is_active(self) -> bool:
        return True


async def _setup(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[CollaborationCore, Room, str]:
    """A bridge holding a room for CHANNEL, with a person's post `p-person`,
    an agent's reply the bridge posted as `p-agent`, and a message written in
    Switch that never reached the platform."""
    async with session_factory() as session:
        bridge_client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge",
            type="bridge",
        )
        person = Client(
            transport_user_id=f"@person-{uuid.uuid4().hex[:8]}:test",
            display_name="alice",
            type="user",
        )
        session.add_all([bridge_client, person])
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        session.add(
            ExternalUser(
                bridge_id=bridge.id,
                external_user_id="U1",
                external_username="alice",
                client_id=person.id,
            )
        )
        room = Room(
            transport_room_id=f"!takeback-{uuid.uuid4().hex[:8]}:test",
            name="takeback",
            description="takeback",
            bridge_id=bridge.id,
            external_channel_id=CHANNEL,
        )
        session.add(room)
        await session.flush()
        for event_id, sender in (
            ("$person", person.transport_user_id),
            ("$agent", "@agent:test"),
            ("$switch-only", "@agent:test"),
        ):
            await MessageStore().create(
                session,
                Message(
                    room_id=room.id,
                    transport_event_id=event_id,
                    sender_id=sender,
                    event_type="m.room.message",
                    msgtype="m.text",
                    body=event_id,
                    content={"msgtype": "m.text", "body": event_id},
                ),
                [],
            )
        for event_id, post in (("$person", "p-person"), ("$agent", "p-agent")):
            session.add(
                BridgeMessageMap(
                    bridge_id=bridge.id,
                    external_channel_id=CHANNEL,
                    transport_event_id=event_id,
                    external_post_id=post,
                )
            )
        await session.commit()

    core = CollaborationCore.__new__(CollaborationCore)
    core._bridge_id = bridge.id
    core._bridge_tenant_id = room.tenant_id
    core._room_tenants = {room.id: room.tenant_id}
    core._channel_to_room = {CHANNEL: (room.id, room.transport_room_id)}
    core._channel_locks = {}
    core._session_factory = session_factory
    core._platform_deletions = PlatformDeletions()
    core._adapter = _Adapter()  # type: ignore[assignment]
    core._trust_client = NullTrustClient()
    core._room_service = _RoomService()  # type: ignore[assignment]
    return core, room, person.transport_user_id


async def _bodies(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, str]:
    async with session_factory() as session:
        rows = (await session.execute(select(Message))).scalars().all()
    return {row.transport_event_id: row.body or "" for row in rows}


class TestDeleted:
    async def test_a_persons_post_deleted_there_is_deleted_here(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, _, _ = await _setup(session_factory)

        await core._handle_message_deleted(
            InboundMessageDeleted(channel_id=CHANNEL, message_ref="p-person")
        )

        assert set(await _bodies(session_factory)) == {"$agent", "$switch-only"}

    async def test_a_post_carrying_a_message_written_in_switch_is_left_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, _, _ = await _setup(session_factory)

        await core._handle_message_deleted(
            InboundMessageDeleted(channel_id=CHANNEL, message_ref="p-agent")
        )
        await core._handle_message_deleted(
            InboundMessageDeleted(channel_id=CHANNEL, message_ref="p-unknown")
        )
        await core._handle_message_deleted(
            InboundMessageDeleted(channel_id="C-unbridged", message_ref="p-person")
        )

        assert set(await _bodies(session_factory)) == {
            "$person",
            "$agent",
            "$switch-only",
        }


class TestEdited:
    async def test_the_copy_says_the_new_words_in_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, _, _ = await _setup(session_factory)
        async with session_factory() as session:
            before = await MessageStore().get_by_transport_event_id(session, "$person")
        assert before is not None

        await core._handle_message_edited(
            InboundMessageEdited(
                channel_id=CHANNEL, message_ref="p-person", content="hi <@U1>"
            )
        )

        async with session_factory() as session:
            after = await MessageStore().get_by_transport_event_id(session, "$person")
            mapping = (
                await session.execute(
                    select(BridgeMessageMap).where(
                        BridgeMessageMap.transport_event_id == "$person"
                    )
                )
            ).scalar_one_or_none()
        assert after is not None
        assert after.body == "hi @alice"
        assert after.seq == before.seq
        assert EDITED_AT_KEY in after.content
        assert mapping is not None

    async def test_an_edit_never_writes_a_new_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, _, _ = await _setup(session_factory)

        await core._handle_message_edited(
            InboundMessageEdited(
                channel_id=CHANNEL, message_ref="p-unknown", content="x"
            )
        )
        await core._handle_message_edited(
            InboundMessageEdited(channel_id=CHANNEL, message_ref="p-agent", content="x")
        )

        assert await _bodies(session_factory) == {
            "$person": "$person",
            "$agent": "$agent",
            "$switch-only": "$switch-only",
        }

    async def test_words_switch_trust_refuses_delete_the_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, _, _ = await _setup(session_factory)
        core._trust_client = _Blocking()  # type: ignore[assignment]

        await core._handle_message_edited(
            InboundMessageEdited(
                channel_id=CHANNEL, message_ref="p-person", content="secret"
            )
        )

        assert set(await _bodies(session_factory)) == {"$agent", "$switch-only"}


class TestChannelRemoved:
    async def test_a_deleted_channel_takes_every_message_and_the_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, room, _ = await _setup(session_factory)

        await core._handle_channel_removed(
            InboundChannelRemoved(channel_id=CHANNEL, deleted=True)
        )

        service: Any = core._room_service
        assert await _bodies(session_factory) == {}
        assert service.unlinked == [room.id]
        assert service.changed == [(room.tenant_id, room.id)]

    async def test_an_archived_channel_takes_only_the_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        core, room, _ = await _setup(session_factory)

        await core._handle_channel_removed(
            InboundChannelRemoved(channel_id=CHANNEL, deleted=False)
        )

        service: Any = core._room_service
        assert len(await _bodies(session_factory)) == 3
        assert service.unlinked == [room.id]


def test_the_handlers_are_installed_before_the_adapter_starts() -> None:
    installed: dict[str, Any] = {}

    class _StartAdapter:
        def set_channel_migration_handler(self, handler: Any) -> None: ...
        def set_channel_type_handler(self, handler: Any) -> None: ...
        def set_channel_rename_handler(self, handler: Any) -> None: ...
        def set_agent_presentation_resolver(self, resolver: Any) -> None: ...

        def set_takeback_handlers(self, **handlers: Any) -> None:
            installed.update(handlers)

        async def start(self, **kwargs: Any) -> None:
            assert set(installed) == {
                "on_message_deleted",
                "on_message_edited",
                "on_channel_removed",
            }

    core = CollaborationCore.__new__(CollaborationCore)
    core._adapter = _StartAdapter()  # type: ignore[assignment]
    core._active = False
    core._identity_task = None

    async def _noop() -> None:
        return None

    core._load_channel_map = _noop  # type: ignore[method-assign]
    core._load_existing_human_actors = _noop  # type: ignore[method-assign]
    core._provision_identities_on_attach = lambda: None  # type: ignore[method-assign]
    asyncio.run(CollaborationCore.start(core))

    assert set(installed) == {
        "on_message_deleted",
        "on_message_edited",
        "on_channel_removed",
    }
