"""People, bots and accounts are counted apart.

A messaging platform relays an integration's posts — an alerting app, CI,
another Switch server's agent — through the same kind of chat identity a person
gets. `chat_identity_active_*` counted both; `person_identity_active_*` and
`bot_identity_active_*` split them on the mark the bridge puts on an app's post,
and `account_active_*` is `user_active_*` under the name it keeps.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import SENDER_IS_APP_MARKER
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Message,
    Room,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry.snapshot import collect_usage


async def _identity_posts(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    posts: list[tuple[bool, timedelta]],
    claimed_by: str | None = None,
    agent_in_room: bool = True,
) -> None:
    """One chat identity posts in a room of its own. Each post is `(as_app,
    age)`: whether the bridge marked it as an app's, and how long ago."""
    suffix = uuid.uuid4().hex[:8]
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        bridge_client = Client(
            transport_user_id=f"@bridge-{suffix}:test",
            display_name="bridge",
            type="bridge",
        )
        identity = Client(
            transport_user_id=f"@identity-{suffix}:test",
            display_name="identity",
            type="user",
        )
        agent = Client(
            transport_user_id=f"@agent-{suffix}:test",
            display_name="agent",
            type="agent",
        )
        room = Room(
            transport_room_id=f"!{suffix}:test",
            name=f"room-{suffix}",
            description="",
            metadata_={"created_by_kind": "user"},
        )
        session.add_all([bridge_client, identity, agent, room])
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        chat_account = ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"U{suffix}",
            external_username=f"identity-{suffix}",
            client_id=identity.id,
        )
        session.add(chat_account)
        if agent_in_room:
            session.add(ClientRoom(client_id=agent.id, room_id=room.id))
        await session.flush()
        if claimed_by is not None:
            session.add(
                ExternalUserClaim(external_user_id=chat_account.id, user_id=claimed_by)
            )
        for seq, (as_app, age) in enumerate(posts, start=1):
            content: dict[str, object] = {"body": "hello"}
            if as_app:
                content[SENDER_IS_APP_MARKER] = True
            session.add(
                Message(
                    room_id=room.id,
                    seq=seq,
                    transport_event_id=f"$evt-{suffix}-{seq}",
                    sender_id=identity.transport_user_id,
                    sender_client_id=identity.id,
                    event_type="m.room.message",
                    msgtype="m.text",
                    body="hello",
                    content=content,
                    sent_at=datetime.now(UTC) - age,
                )
            )
        await session.commit()


async def _account(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(
            name="someone", email=f"{uuid.uuid4().hex[:6]}@example.com", role="user"
        )
        session.add(user)
        await session.commit()
        return user.id


HOUR = timedelta(hours=1)
THREE_DAYS = timedelta(days=3)


async def test_a_person_and_an_integration_are_one_of_each(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _identity_posts(session_factory, posts=[(False, HOUR)])
    await _identity_posts(session_factory, posts=[(True, HOUR)])

    counts = await collect_usage(session_factory)

    assert counts.chat_identity_active_1d == 2
    assert counts.person_identity_active_1d == 1
    assert counts.bot_identity_active_1d == 1
    assert counts.person_identity_active_7d == 1
    assert counts.bot_identity_active_7d == 1


async def test_an_integration_with_unmarked_older_posts_is_still_a_bot(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Posts relayed before its bridge marked app posts carry no mark. One marked
    post in the window makes the whole identity a bot, not a person as well."""
    await _identity_posts(session_factory, posts=[(False, THREE_DAYS), (True, HOUR)])

    counts = await collect_usage(session_factory)

    assert counts.person_identity_active_7d == 0
    assert counts.bot_identity_active_7d == 1
    assert counts.chat_identity_active_7d == 1


async def test_the_day_and_the_week_are_judged_on_their_own_posts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An identity whose only marked post is days old is a bot for the week and,
    with an unmarked post today, a person for the day: each window decides from
    what it can see."""
    await _identity_posts(session_factory, posts=[(True, THREE_DAYS), (False, HOUR)])

    counts = await collect_usage(session_factory)

    assert counts.person_identity_active_1d == 1
    assert counts.bot_identity_active_1d == 0
    assert counts.person_identity_active_7d == 0
    assert counts.bot_identity_active_7d == 1


async def test_neither_counts_without_an_agent_in_the_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _identity_posts(session_factory, posts=[(False, HOUR)], agent_in_room=False)
    await _identity_posts(session_factory, posts=[(True, HOUR)], agent_in_room=False)

    counts = await collect_usage(session_factory)

    assert counts.person_identity_active_7d == 0
    assert counts.bot_identity_active_7d == 0


async def test_account_active_is_user_active_under_its_new_name(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory)
    await _identity_posts(session_factory, posts=[(False, HOUR)], claimed_by=someone)
    await _identity_posts(session_factory, posts=[(False, THREE_DAYS)])

    counts = await collect_usage(session_factory)

    assert counts.account_active_1d == counts.user_active_1d == 1
    assert counts.account_active_7d == counts.user_active_7d == 1
    assert counts.person_identity_active_7d == 2


async def test_the_snapshot_event_carries_all_three(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _identity_posts(session_factory, posts=[(False, HOUR)])
    await _identity_posts(session_factory, posts=[(True, HOUR)])

    properties = (await collect_usage(session_factory)).as_event_properties(
        session_live_count=0
    )

    assert properties["person_identity_active_7d"] == 1
    assert properties["bot_identity_active_7d"] == 1
    assert properties["account_active_7d"] == 0
