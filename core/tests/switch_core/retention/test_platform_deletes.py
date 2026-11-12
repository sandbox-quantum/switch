"""Following a platform's deletions and edits, against real Postgres.

What a mock could not show: that a post deleted in the middle of a room takes
its files, mappings, agents' copies and pending work with it and nothing else,
that readers paging past the gap carry on, that a deleted newest row's number
is never given out again, and that an edit is made in place.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.db.models import (
    Agent,
    AgentEventRow,
    ApiKey,
    BridgeMessageMap,
    Client,
    CollaborationBridge,
    ExternalUser,
    MediaBlob,
    Message,
    MessageAttachment,
    PendingAttachmentGroup,
    PendingDecision,
    Room,
    User,
)
from switch_core.db.stores.message_store import MessageStore
from switch_core.retention.platform_deletes import PlatformDeletions
from switch_core.transport.content import EDITED_AT_KEY

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)


async def _bridge(session: AsyncSession) -> CollaborationBridge:
    client = Client(
        transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Acme Slack", client_id=client.id, status="active"
    )
    session.add(bridge)
    await session.flush()
    return bridge


async def _person(session: AsyncSession, bridge: CollaborationBridge) -> str:
    """A person on `bridge`; their transport id."""
    name = f"person-{uuid.uuid4().hex[:6]}"
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="user")
    session.add(client)
    await session.flush()
    session.add(
        ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"U-{name}",
            external_username=name,
            client_id=client.id,
        )
    )
    await session.flush()
    return client.transport_user_id


async def _agent(session: AsyncSession) -> Agent:
    name = f"agent-{uuid.uuid4().hex[:6]}"
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=name,
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _room(session: AsyncSession, name: str) -> Room:
    room = Room(
        transport_room_id=f"!{name}-{uuid.uuid4().hex[:8]}:test",
        name=name,
        description=name,
    )
    session.add(room)
    await session.flush()
    return room


async def _message(
    session: AsyncSession,
    room: Room,
    event_id: str,
    *,
    sender: str = "@agent:test",
    uri: str | None = None,
    group: str | None = None,
    formatted: bool = False,
) -> Message:
    content: dict[str, object] = {"msgtype": "m.text", "body": event_id}
    if uri is not None:
        content = {"msgtype": "m.file", "body": f"{event_id}.txt", "url": uri}
    if group is not None:
        content[ATTACHMENT_GROUP_KEY] = {"id": group, "index": 0, "total": 2}
    if formatted:
        content["formatted_body"] = f"<p>{event_id}</p>"
    attachments = (
        []
        if uri is None
        else [
            MessageAttachment(
                uri=uri, filename=f"{event_id}.txt", mimetype="text/plain", size=1
            )
        ]
    )
    return await MessageStore().create(
        session,
        Message(
            room_id=room.id,
            transport_event_id=event_id,
            sender_id=sender,
            event_type="m.room.message",
            msgtype=str(content["msgtype"]),
            body=str(content["body"]),
            formatted_body=content.get("formatted_body"),
            content=content,
            sent_at=NOW,
        ),
        attachments,
    )


def _map(bridge: CollaborationBridge, event_id: str, post: str) -> BridgeMessageMap:
    return BridgeMessageMap(
        bridge_id=bridge.id,
        external_channel_id="C1",
        transport_event_id=event_id,
        external_post_id=post,
    )


async def _blob(session: AsyncSession, uri: str) -> None:
    session.add(
        MediaBlob(
            uri=uri,
            content_type="text/plain",
            filename="f.txt",
            size=1,
            data=b"x",
            created_at=NOW,
        )
    )
    await session.flush()


async def _event_ids(session: AsyncSession) -> set[str]:
    return set((await session.execute(select(Message.transport_event_id))).scalars())


class TestFindPost:
    async def test_finds_only_what_a_person_wrote_on_the_platform_in_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        deletions = PlatformDeletions()
        async with session_factory() as session:
            bridge = await _bridge(session)
            person = await _person(session, bridge)
            room = await _room(session, "find")
            other_room = await _room(session, "other")
            await _message(session, room, "$person", sender=person)
            await _message(session, room, "$agent-reply")
            await _message(session, other_room, "$elsewhere", sender=person)
            session.add_all(
                [
                    _map(bridge, "$person", "p-person"),
                    _map(bridge, "$agent-reply", "p-agent"),
                    _map(bridge, "$elsewhere", "p-elsewhere"),
                ]
            )
            await session.flush()

            async def find(post: str) -> str | None:
                found = await deletions.find_post(
                    session, bridge_id=bridge.id, room_id=room.id, external_post_id=post
                )
                return None if found is None else found.transport_event_id

            assert await find("p-person") == "$person"
            assert await find("p-agent") is None
            assert await find("p-elsewhere") is None
            assert await find("p-never-relayed") is None


class TestDeletePost:
    async def test_takes_the_post_and_what_derives_from_it_and_nothing_else(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        deletions = PlatformDeletions()
        async with session_factory() as session:
            bridge = await _bridge(session)
            person = await _person(session, bridge)
            agent = await _agent(session)
            room = await _room(session, "delete")
            await _message(session, room, "$before")
            for uri in ("switch-media://a", "switch-media://b", "switch-media://kept"):
                await _blob(session, uri)
            first = await _message(
                session,
                room,
                "$file-1",
                sender=person,
                uri="switch-media://a",
                group="g1",
            )
            await _message(
                session,
                room,
                "$file-2",
                sender=person,
                uri="switch-media://b",
                group="g1",
            )
            await _message(
                session, room, "$quote", uri="switch-media://kept", group=None
            )
            await _message(
                session, room, "$also-kept", sender=person, uri="switch-media://kept"
            )
            after = await _message(session, room, "$after")
            session.add_all(
                [
                    _map(bridge, "$file-1", "p1"),
                    _map(bridge, "$after", "p-after"),
                    PendingDecision(
                        room_id=room.id, room_seq=first.seq, message_key="$file-1"
                    ),
                    PendingAttachmentGroup(
                        room_id=room.id,
                        group_id="g1",
                        total=3,
                        from_seq=first.seq,
                        deadline=NOW + timedelta(minutes=1),
                    ),
                ]
            )
            for seq, key in enumerate(("g1", "$after"), start=1):
                session.add(
                    AgentEventRow(
                        agent_id=agent.id,
                        seq=seq,
                        room_id=room.id,
                        room_seq=after.seq,
                        message_key=key,
                        type="message",
                        payload={"payload": {"body": key}},
                        notifiable=True,
                    )
                )
            await session.commit()

        async with session_factory() as session, session.begin():
            found = await deletions.find_post(
                session, bridge_id=bridge.id, room_id=room.id, external_post_id="p1"
            )
            assert found is not None
            deleted = await deletions.delete_post(session, found)

        assert sorted(deleted.event_ids) == ["$file-1", "$file-2"]
        async with session_factory() as session:
            assert await _event_ids(session) == {
                "$before",
                "$quote",
                "$also-kept",
                "$after",
            }
            uris = set((await session.execute(select(MessageAttachment.uri))).scalars())
            blobs = set((await session.execute(select(MediaBlob.uri))).scalars())
            mapped = set(
                (
                    await session.execute(select(BridgeMessageMap.transport_event_id))
                ).scalars()
            )
            copies = set(
                (await session.execute(select(AgentEventRow.message_key))).scalars()
            )
            decisions = await session.scalar(
                select(func.count()).select_from(PendingDecision)
            )
            groups = await session.scalar(
                select(func.count()).select_from(PendingAttachmentGroup)
            )
        assert uris == {"switch-media://kept"}
        assert blobs == {"switch-media://kept"}
        assert mapped == {"$after"}
        assert copies == {"$after"}
        assert decisions == 0
        assert groups == 0

    async def test_readers_page_past_the_gap_and_a_deleted_newest_number_stays_used(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        deletions = PlatformDeletions()
        async with session_factory() as session:
            room = await _room(session, "numbering")
            one = await _message(session, room, "$1")
            two = await _message(session, room, "$2")
            three = await _message(session, room, "$3")
            await session.commit()

        async with session_factory() as session, session.begin():
            await deletions.delete_post(session, two)
            await deletions.delete_post(session, three)

        async with session_factory() as session:
            from_start = await store.list_for_room(
                session, room.id, after_seq=0, limit=10
            )
            from_one = await store.list_for_room(
                session, room.id, after_seq=one.seq, limit=10
            )
            assert await store.head_seq(session, room.id) == three.seq
            fresh = await _message(session, room, "$4")
            await session.commit()
            after_three = await store.list_for_room(
                session, room.id, after_seq=three.seq, limit=10
            )
        assert [m.transport_event_id for m in from_start] == ["$1"]
        assert from_one == []
        assert fresh.seq == three.seq + 1
        assert [m.transport_event_id for m in after_three] == ["$4"]


class TestReplaceText:
    async def test_edits_in_place_with_the_agents_copies(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        deletions = PlatformDeletions()
        async with session_factory() as session:
            room = await _room(session, "edit")
            agent = await _agent(session)
            message = await _message(session, room, "$edited", formatted=True)
            other = await _message(session, room, "$untouched")
            for seq, key in enumerate(("$edited", "$untouched"), start=1):
                session.add(
                    AgentEventRow(
                        agent_id=agent.id,
                        seq=seq,
                        room_id=room.id,
                        room_seq=other.seq,
                        message_key=key,
                        type="message",
                        payload={"type": "message", "payload": {"body": key}},
                        notifiable=True,
                    )
                )
            await session.commit()
            seq = message.seq

        async with session_factory() as session, session.begin():
            row = await MessageStore().get_by_transport_event_id(session, "$edited")
            assert row is not None
            await deletions.replace_text(
                session, row, "new **words**", edited_at_ms=1234
            )

        async with session_factory() as session:
            row = await MessageStore().get_by_transport_event_id(session, "$edited")
            untouched = await MessageStore().get_by_transport_event_id(
                session, "$untouched"
            )
            payloads = {
                r.message_key: r.payload
                for r in (await session.execute(select(AgentEventRow))).scalars()
            }
        assert row is not None and untouched is not None
        assert row.seq == seq
        assert row.body == "new **words**"
        assert row.content["body"] == "new **words**"
        assert row.content[EDITED_AT_KEY] == 1234
        assert row.formatted_body == "<p>new <strong>words</strong></p>"
        assert untouched.body == "$untouched"
        assert payloads["$edited"]["payload"]["body"] == "new **words**"
        assert payloads["$edited"]["type"] == "message"
        assert payloads["$untouched"]["payload"]["body"] == "$untouched"

    async def test_a_file_takes_the_new_words_as_its_caption(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        deletions = PlatformDeletions()
        async with session_factory() as session:
            room = await _room(session, "caption")
            message = await _message(session, room, "$file", uri="switch-media://f")
            await deletions.replace_text(session, message, "a caption", edited_at_ms=1)
            assert message.content["body"] == "a caption"
            assert message.content["filename"] == "$file.txt"
            await deletions.replace_text(session, message, "", edited_at_ms=2)
            assert message.content["body"] == "$file.txt"
            assert "filename" not in message.content


class TestDeleteRoomMessages:
    async def test_empties_the_room_and_numbering_continues(
        self, session_factory: async_sessionmaker[AsyncSession], monkeypatch
    ) -> None:
        monkeypatch.setattr("switch_core.retention.platform_deletes.DELETE_BATCH", 2)
        store = MessageStore()
        async with session_factory() as session:
            room = await _room(session, "gone")
            other = await _room(session, "stays")
            for index in range(5):
                await _message(session, room, f"$gone-{index}")
            await _message(session, other, "$stays")
            await session.commit()
            tenant_id = room.tenant_id

        deleted = await PlatformDeletions().delete_room_messages(
            session_factory, tenant_id, room.id
        )

        async with session_factory() as session:
            assert await _event_ids(session) == {"$stays"}
            assert await store.head_seq(session, room.id) == 5
            fresh = await _message(session, room, "$fresh")
            await session.commit()
        assert deleted == 5
        assert fresh.seq == 6
