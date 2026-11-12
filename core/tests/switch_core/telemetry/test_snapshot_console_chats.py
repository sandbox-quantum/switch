"""A person speaking in Switch Console is a person in every count.

What someone writes in a Switch Console chat is written by their `member`
client — one per account per tenant — not by a platform identity. The
snapshot counts it as a chat identity and its account as active, exactly as
it counts a Slack identity and the account that claimed it, and
`console_account_active_*` says how many of the active accounts came that way.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import CHAT_OPERATION_ID_KEY, MEMBER_CLIENT_TYPE
from switch_core.db.models import TENANT_ZERO_ID, Client, ClientRoom, Message, Room
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry.snapshot import (
    collect_period_counts,
    collect_usage,
    newly_active_rooms,
    room_had_human_activity,
)
from tests.switch_core.telemetry.test_snapshot_accounts import (
    _account,
    _chat_account_speaks,
)


async def _console_chat(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str,
    agent_replies: bool,
    spoke_at: datetime | None = None,
    agent_in_room: bool = True,
    channel_type: str = "direct",
) -> str:
    """`user_id` says something in a Switch Console chat with an agent, through
    their member client, and the agent answers if `agent_replies`. Returns the
    room id."""
    suffix = uuid.uuid4().hex[:8]
    at = spoke_at or datetime.now(UTC) - timedelta(hours=1)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        member = Client(
            transport_user_id=f"@switch-member-{suffix}:test",
            display_name="person",
            type=MEMBER_CLIENT_TYPE,
            user_id=user_id,
        )
        agent = Client(
            transport_user_id=f"@agent-{suffix}:test",
            display_name="agent",
            type="agent",
        )
        room = Room(
            transport_room_id=f"!{suffix}:test",
            name=f"chat-{suffix}",
            description="",
            channel_type=channel_type,
            metadata_={"created_by_kind": "user", CHAT_OPERATION_ID_KEY: suffix},
        )
        session.add_all([member, agent, room])
        await session.flush()
        session.add(ClientRoom(client_id=member.id, room_id=room.id))
        if agent_in_room:
            session.add(ClientRoom(client_id=agent.id, room_id=room.id))
        posts = [(member, at)]
        if agent_replies:
            posts.append((agent, at + timedelta(seconds=5)))
        for seq, (sender, sent_at) in enumerate(posts, start=1):
            session.add(
                Message(
                    room_id=room.id,
                    seq=seq,
                    transport_event_id=f"$evt-{suffix}-{seq}",
                    sender_id=sender.transport_user_id,
                    sender_client_id=sender.id,
                    event_type="m.room.message",
                    msgtype="m.text",
                    body="hello",
                    content={"body": "hello"},
                    sent_at=sent_at,
                )
            )
        await session.commit()
        return room.id


async def test_a_console_chat_counts_its_person_account_room_and_messages(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _console_chat(session_factory, user_id=someone, agent_replies=True)

    counts = await collect_usage(session_factory)

    assert counts.chat_identity_count == 1
    assert counts.person_identity_active_1d == 1
    assert counts.chat_identity_posted_1d == 1
    assert counts.chat_identity_in_room_count == 1
    assert counts.account_active_1d == counts.user_active_1d == 1
    assert counts.console_account_active_1d == 1
    assert counts.console_account_active_7d == 1
    assert counts.room_active_1d == 1
    assert counts.message_from_human_1d == 1
    assert counts.turn_human_to_agent_1d == 1
    assert counts.room_membership_total == 1


async def test_slack_and_console_are_two_identities_and_one_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(session_factory, claimed_by=[someone])
    await _console_chat(session_factory, user_id=someone, agent_replies=False)

    counts = await collect_usage(session_factory)

    assert counts.person_identity_active_1d == 2
    assert counts.account_active_1d == 1
    assert counts.console_account_active_1d == 1


async def test_only_console_accounts_count_as_console(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    on_slack = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    in_console = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(session_factory, claimed_by=[on_slack])
    await _console_chat(
        session_factory,
        user_id=in_console,
        agent_replies=False,
        spoke_at=datetime.now(UTC) - timedelta(days=3),
    )

    counts = await collect_usage(session_factory)

    assert (counts.account_active_1d, counts.account_active_7d) == (1, 2)
    assert (counts.console_account_active_1d, counts.console_account_active_7d) == (
        0,
        1,
    )


async def test_a_console_chat_with_no_agent_is_not_activity(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The same rule as any room: people talking among themselves have said
    something, but have not used an agent."""
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    room_id = await _console_chat(
        session_factory, user_id=someone, agent_replies=False, agent_in_room=False
    )

    counts = await collect_usage(session_factory)

    assert counts.chat_identity_posted_1d == 1
    assert counts.person_identity_active_1d == 0
    assert counts.account_active_1d == 0
    assert counts.console_account_active_1d == 0
    assert counts.room_active_1d == 0
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        assert not await room_had_human_activity(session, TENANT_ZERO_ID, room_id)


async def test_a_used_console_chat_was_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    room_id = await _console_chat(session_factory, user_id=someone, agent_replies=True)

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        assert await room_had_human_activity(session, TENANT_ZERO_ID, room_id)


async def test_a_period_counts_console_use(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    now = datetime.now(UTC)
    await _console_chat(session_factory, user_id=someone, agent_replies=True)

    counts = await collect_period_counts(
        session_factory, start=now - timedelta(days=1), end=now
    )

    assert counts.room_active == 1
    assert counts.person_identity_active == 1
    assert counts.account_active == 1
    assert counts.console_account_active == 1


async def test_console_only_accounts_have_no_platform_account_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Someone also active on Slack is a Console account but not a
    Console-only one; someone only in Console is both."""
    both = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    only_console = await _account(
        session_factory, f"{uuid.uuid4().hex[:6]}@example.com"
    )
    await _chat_account_speaks(session_factory, claimed_by=[both])
    await _console_chat(session_factory, user_id=both, agent_replies=False)
    await _console_chat(session_factory, user_id=only_console, agent_replies=False)

    counts = await collect_usage(session_factory)

    assert counts.account_active_1d == 2
    assert counts.console_account_active_1d == 2
    assert counts.console_only_account_active_1d == 1
    assert counts.console_only_account_active_7d == 1


async def test_slack_last_week_and_console_today_is_console_only_for_the_day(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(
        session_factory,
        claimed_by=[someone],
        spoke_at=datetime.now(UTC) - timedelta(days=3),
    )
    await _console_chat(session_factory, user_id=someone, agent_replies=False)

    counts = await collect_usage(session_factory)

    assert counts.console_only_account_active_1d == 1
    assert counts.console_only_account_active_7d == 0


async def test_console_chats_are_counted_as_direct_group_and_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    first = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    second = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    third = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _console_chat(session_factory, user_id=first, agent_replies=True)
    await _console_chat(
        session_factory,
        user_id=second,
        agent_replies=True,
        channel_type="channel_private",
    )
    await _console_chat(
        session_factory,
        user_id=third,
        agent_replies=False,
        agent_in_room=False,
        channel_type="channel_private",
    )
    await _chat_account_speaks(session_factory, claimed_by=[])

    counts = await collect_usage(session_factory)

    assert counts.room_console_chat_direct_count == 1
    assert counts.room_console_chat_group_count == 2
    assert counts.room_console_chat_active_7d == 2
    assert counts.room_active_7d == 3


async def test_a_period_counts_console_accounts_apart(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    on_slack = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    in_console = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    now = datetime.now(UTC)
    await _chat_account_speaks(session_factory, claimed_by=[on_slack])
    await _console_chat(session_factory, user_id=in_console, agent_replies=True)

    counts = await collect_period_counts(
        session_factory, start=now - timedelta(days=1), end=now
    )

    assert counts.account_active == 2
    assert counts.console_account_active == 1


async def test_a_console_chat_becoming_active_says_it_is_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _console_chat(session_factory, user_id=someone, agent_replies=True)
    await _chat_account_speaks(session_factory, claimed_by=[])

    found = await newly_active_rooms(
        session_factory, since=datetime.now(UTC) - timedelta(days=1)
    )

    assert sorted(room.console_chat for room in found) == [False, True]


async def test_an_archived_console_chat_is_not_counted_as_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The Console chat counts are of unarchived chats, so the active count
    stays within direct plus group."""
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    room_id = await _console_chat(session_factory, user_id=someone, agent_replies=True)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        room = await session.get(Room, room_id)
        assert room is not None
        room.archived_at = datetime.now(UTC)
        await session.commit()

    counts = await collect_usage(session_factory)

    assert counts.room_console_chat_direct_count == 0
    assert counts.room_console_chat_active_7d == 0
