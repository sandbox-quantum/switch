"""Data retention against real Postgres.

What a mock could not show: that deleting a message takes its attachment rows
with it by cascade, that a room emptied by retention keeps numbering above
what it had, that a stored file still quoted by a kept message survives, and
that one workspace's window never reaches another's rows.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    ApprovalRequest,
    BridgeMessageMap,
    Client,
    CollaborationBridge,
    Invitation,
    MediaBlob,
    Message,
    MessageAttachment,
    MessagingInstallState,
    Room,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.retention_store import RetentionStore
from switch_core.retention import service as retention_service
from switch_core.retention.service import RetentionService
from switch_core.tenant_context import tenant_scope

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
BUDGET = timedelta(minutes=5)
OTHER_TENANT = "retention-other-tenant"


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


async def _room(session: AsyncSession, name: str, *, archived: bool = False) -> Room:
    room = Room(
        transport_room_id=f"!{name}-{uuid.uuid4().hex[:8]}:test",
        name=name,
        description=name,
        archived_at=NOW - timedelta(days=500) if archived else None,
    )
    session.add(room)
    await session.flush()
    return room


async def _message(
    session: AsyncSession,
    room: Room,
    event_id: str,
    *,
    age_days: float,
    attachment_uri: str | None = None,
) -> Message:
    attachments = (
        []
        if attachment_uri is None
        else [
            MessageAttachment(
                uri=attachment_uri,
                filename="f.txt",
                mimetype="text/plain",
                size=1,
            )
        ]
    )
    return await MessageStore().create(
        session,
        Message(
            room_id=room.id,
            transport_event_id=event_id,
            sender_id="@sender:test",
            event_type="m.room.message",
            msgtype="m.text",
            body=event_id,
            content={"msgtype": "m.text", "body": event_id},
            sent_at=NOW - timedelta(days=age_days),
        ),
        attachments,
    )


async def _blob(session: AsyncSession, uri: str, *, age_days: float) -> None:
    session.add(
        MediaBlob(
            uri=uri,
            content_type="text/plain",
            filename="f.txt",
            size=1,
            data=b"x",
            created_at=NOW - timedelta(days=age_days),
        )
    )
    await session.flush()


async def _event_ids(session: AsyncSession) -> set[str]:
    return set((await session.execute(select(Message.transport_event_id))).scalars())


async def _set_policy(
    session_factory: async_sessionmaker[AsyncSession], days: int, tenant_id: str
) -> None:
    async with tenant_session(session_factory, tenant_id) as session:
        user = await _user(session, f"policy-{uuid.uuid4().hex[:6]}")
        await RetentionStore().set_policy(
            session, message_retention_days=days, user_id=user.id
        )
        await session.commit()


class TestMessages:
    async def test_without_a_policy_nothing_is_deleted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, "forever")
            await _message(session, room, "$ancient", age_days=3000)
            await session.commit()

        result = await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            assert await _event_ids(session) == {"$ancient"}
        assert result.messages == 0

    async def test_messages_older_than_the_window_go_in_every_room_archived_too(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            active = await _room(session, "active")
            archived = await _room(session, "archived", archived=True)
            await _message(session, active, "$old-active", age_days=31)
            await _message(session, active, "$new-active", age_days=29)
            await _message(session, archived, "$old-archived", age_days=400)
            await session.commit()
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        result = await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            assert await _event_ids(session) == {"$new-active"}
        assert result.messages == 2
        assert not result.backlog

    async def test_attachments_and_bridge_mappings_go_with_their_message(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, "files")
            await _message(
                session, room, "$old", age_days=60, attachment_uri="switch-media://old"
            )
            client = Client(
                transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
                display_name="bridge",
                type="bridge",
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type="mattermost",
                display_name="MM",
                client_id=client.id,
                status="active",
            )
            session.add(bridge)
            await session.flush()
            for event_id in ("$old", "$unrelated"):
                session.add(
                    BridgeMessageMap(
                        bridge_id=bridge.id,
                        external_channel_id="chan",
                        transport_event_id=event_id,
                        external_post_id=f"post{event_id}",
                    )
                )
            await session.commit()
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            attachments = await session.scalar(
                select(func.count()).select_from(MessageAttachment)
            )
            mapped = set(
                (
                    await session.execute(select(BridgeMessageMap.transport_event_id))
                ).scalars()
            )
        assert attachments == 0
        assert mapped == {"$unrelated"}

    async def test_another_workspaces_window_does_not_reach_this_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(Tenant(id=OTHER_TENANT, slug=OTHER_TENANT, name=OTHER_TENANT))
            await session.commit()
        async with session_factory() as session:
            room = await _room(session, "tenant-zero")
            await _message(session, room, "$zero-old", age_days=60)
            await session.commit()
        async with tenant_session(session_factory, OTHER_TENANT) as session:
            room = await _room(session, "other")
            await _message(session, room, "$other-old", age_days=60)
            await session.commit()
        await _set_policy(session_factory, 30, OTHER_TENANT)

        with tenant_scope(OTHER_TENANT):
            await RetentionService(session_factory).apply(NOW, BUDGET)
        with tenant_scope(TENANT_ZERO_ID):
            await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            assert await _event_ids(session) == {"$zero-old"}


class TestNumbering:
    async def test_a_room_emptied_by_retention_keeps_numbering_above_what_it_had(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _room(session, "emptied")
            for index in range(3):
                await _message(session, room, f"$old{index}", age_days=60)
            await session.commit()
            head_before = await store.head_seq(session, room.id)
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            head_after = await store.head_seq(session, room.id)
            fresh = await _message(session, room, "$fresh", age_days=0)
            await session.commit()
        assert head_before == head_after == 3
        assert fresh.seq == 4

    async def test_reconstructed_history_does_not_lower_the_floor(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = MessageStore()
        async with session_factory() as session:
            room = await _room(session, "backfilled")
            await store.create_historical(
                session,
                Message(
                    room_id=room.id,
                    transport_event_id="$history",
                    sender_id="@sender:test",
                    event_type="m.room.message",
                    msgtype="m.text",
                    body="history",
                    content={"msgtype": "m.text", "body": "history"},
                    sent_at=NOW - timedelta(days=90),
                ),
                [],
            )
            await session.commit()
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            refreshed = await session.get(Room, room.id)
            assert refreshed is not None
            assert refreshed.seq_floor == 0
            assert await store.head_seq(session, room.id) == 0


class TestMedia:
    async def test_only_old_files_nothing_refers_to_are_deleted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, "media")
            await _blob(session, "switch-media://quoted", age_days=10)
            await _message(
                session,
                room,
                "$kept",
                age_days=1,
                attachment_uri="switch-media://quoted",
            )
            await _blob(session, "switch-media://orphan", age_days=10)
            await _blob(session, "switch-media://just-uploaded", age_days=0.1)
            await session.commit()

        result = await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            uris = set((await session.execute(select(MediaBlob.uri))).scalars())
        assert uris == {"switch-media://quoted", "switch-media://just-uploaded"}
        assert result.media == 1

    async def test_a_file_goes_once_the_last_message_quoting_it_is_deleted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, "media-expiry")
            await _blob(session, "switch-media://shared", age_days=90)
            await _message(
                session, room, "$a", age_days=60, attachment_uri="switch-media://shared"
            )
            await _message(
                session, room, "$b", age_days=10, attachment_uri="switch-media://shared"
            )
            await session.commit()
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        await RetentionService(session_factory).apply(NOW, BUDGET)
        async with session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(MediaBlob)) == 1
            )

        await RetentionService(session_factory).apply(NOW + timedelta(days=21), BUDGET)
        async with session_factory() as session:
            assert (
                await session.scalar(select(func.count()).select_from(MediaBlob)) == 0
            )


async def _agent(session: AsyncSession) -> Agent:
    name = f"agent-{uuid.uuid4().hex[:6]}"
    user = await _user(session, name)
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


class TestLeftovers:
    async def test_settled_approvals_go_after_the_grace_and_owed_answers_stay(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        old = NOW - timedelta(days=31)
        async with session_factory() as session:
            agent = await _agent(session)
            for request_id, state, delivered, updated in (
                ("closed-old", "closed", None, old),
                ("delivered-old", "answered", old, old),
                ("owed-old", "answered", None, old),
                ("open-old", "open", None, old),
                ("closed-recent", "closed", None, NOW - timedelta(days=1)),
            ):
                session.add(
                    ApprovalRequest(
                        agent_id=agent.id,
                        session_id="s1",
                        request_id=request_id,
                        turn_id="t1",
                        kind="approval",
                        title=request_id,
                        options=[],
                        questions=[],
                        state=state,
                        delivered_at=delivered,
                        updated_at=updated,
                    )
                )
            await session.commit()

        result = await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            left = set(
                (await session.execute(select(ApprovalRequest.request_id))).scalars()
            )
        assert left == {"owed-old", "open-old", "closed-recent"}
        assert result.approvals == 2

    async def test_lapsed_invitations_and_expired_install_links_go_after_the_grace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await _user(session, "inviter")
            for label, expires, revoked in (
                ("expired-old", NOW - timedelta(days=31), None),
                ("revoked-old", NOW + timedelta(days=1), NOW - timedelta(days=31)),
                ("expired-recent", NOW - timedelta(days=1), None),
                ("live", NOW + timedelta(days=1), None),
            ):
                session.add(
                    Invitation(
                        role="member",
                        email=f"{label}@example.invalid",
                        token_hash=label,
                        expires_at=expires,
                        uses_remaining=1,
                        revoked_at=revoked,
                        created_by=user.id,
                    )
                )
            for expires in (NOW - timedelta(days=31), NOW - timedelta(days=1)):
                session.add(
                    MessagingInstallState(
                        platform="slack", created_by_user_id=user.id, expires_at=expires
                    )
                )
            await session.commit()

        result = await RetentionService(session_factory).apply(NOW, BUDGET)

        async with session_factory() as session:
            hashes = set(
                (await session.execute(select(Invitation.token_hash))).scalars()
            )
            states = await session.scalar(
                select(func.count()).select_from(MessagingInstallState)
            )
        assert hashes == {"expired-recent", "live"}
        assert states == 1
        assert (result.invitations, result.install_states) == (2, 1)


class TestPass:
    async def test_a_failing_step_does_not_stop_the_others(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        async with session_factory() as session:
            await _blob(session, "switch-media://orphan", age_days=10)
            await session.commit()
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        async def broken(*args: object, **kwargs: object) -> list[str]:
            raise RuntimeError("deleting messages is broken")

        monkeypatch.setattr(MessageStore, "delete_sent_before", broken)
        result = await RetentionService(session_factory).apply(NOW, BUDGET)

        assert result.failed == ("messages",)
        assert result.media == 1

    async def test_a_pass_out_of_time_stops_after_a_batch_and_says_so(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(retention_service, "MESSAGE_BATCH", 2)
        async with session_factory() as session:
            room = await _room(session, "backlog")
            for index in range(5):
                await _message(session, room, f"$old{index}", age_days=60)
            await session.commit()
        await _set_policy(session_factory, 30, TENANT_ZERO_ID)

        first = await RetentionService(session_factory).apply(NOW, timedelta(0))
        rest = await RetentionService(session_factory).apply(NOW, BUDGET)

        assert (first.messages, first.backlog) == (2, True)
        assert (rest.messages, rest.backlog) == (3, False)


class TestPolicy:
    async def test_two_first_saves_at_once_both_succeed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = await _user(session, "racer")
            await session.commit()
            user_id = user.id

        async def save(days: int) -> None:
            async with session_factory() as session:
                await RetentionStore().set_policy(
                    session, message_retention_days=days, user_id=user_id
                )
                await session.commit()

        await asyncio.gather(save(30), save(90))

        async with session_factory() as session:
            policy = await RetentionStore().get_policy(session)
        assert policy is not None
        assert policy.message_retention_days in (30, 90)
