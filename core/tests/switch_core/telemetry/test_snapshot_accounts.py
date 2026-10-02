"""Active users are Switch accounts; chat identities are counted beside them.

A person reaches Switch through a chat account — Slack, Mattermost, and so on
— and an account is active when a chat account it has claimed speaks in a room
with an agent. Unclaimed chat accounts, and one person's second platform, are
what made "active" run above "registered"; they are still counted, as
`chat_identity_*`, so nothing that number showed is lost.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Message,
    Room,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry.snapshot import collect_usage

OTHER_TENANT = "22222222-2222-2222-2222-222222222222"


async def _account(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> str:
    async with session_factory() as session:
        user = User(name=email, email=email, role="user")
        session.add(user)
        await session.commit()
        return user.id


async def _other_tenant(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(
            Tenant(id=OTHER_TENANT, name="other", slug=f"o-{uuid.uuid4().hex[:8]}")
        )
        await session.commit()


async def _chat_account_speaks(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    claimed_by: list[str],
    tenant_id: str = TENANT_ZERO_ID,
    spoke_at: datetime | None = None,
) -> None:
    """A chat account, claimed by `claimed_by`, says something in a room with
    an agent."""
    suffix = uuid.uuid4().hex[:8]
    async with tenant_session(session_factory, tenant_id) as session:
        bridge_client = Client(
            matrix_user_id=f"@bridge-{suffix}:test",
            display_name="bridge",
            type="bridge",
        )
        person = Client(
            matrix_user_id=f"@person-{suffix}:test", display_name="person", type="user"
        )
        agent = Client(
            matrix_user_id=f"@agent-{suffix}:test", display_name="agent", type="agent"
        )
        room = Room(
            matrix_room_id=f"!{suffix}:test",
            name=f"room-{suffix}",
            description="",
            metadata_={"created_by_kind": "user"},
        )
        session.add_all([bridge_client, person, agent, room])
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
            external_username=f"person-{suffix}",
            client_id=person.id,
        )
        session.add(chat_account)
        session.add(ClientRoom(client_id=agent.id, room_id=room.id))
        await session.flush()
        for user_id in claimed_by:
            session.add(
                ExternalUserClaim(external_user_id=chat_account.id, user_id=user_id)
            )
        session.add(
            Message(
                room_id=room.id,
                seq=1,
                transport_event_id=f"$evt-{suffix}",
                sender_id=person.matrix_user_id,
                sender_client_id=person.id,
                event_type="m.room.message",
                msgtype="m.text",
                body="hello",
                content={"body": "hello"},
                sent_at=spoke_at or datetime.now(UTC) - timedelta(hours=1),
            )
        )
        await session.commit()


async def test_a_claimed_chat_account_makes_its_switch_account_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(session_factory, claimed_by=[someone])
    await _chat_account_speaks(session_factory, claimed_by=[])

    counts = await collect_usage(session_factory)

    assert counts.user_active_1d == 1
    assert counts.user_active_7d == 1
    assert counts.chat_identity_active_1d == 2
    assert counts.chat_identity_count == 2


async def test_one_person_on_two_platforms_is_one_active_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(session_factory, claimed_by=[someone])
    await _chat_account_speaks(session_factory, claimed_by=[someone])

    counts = await collect_usage(session_factory)

    assert counts.user_active_1d == 1
    assert counts.chat_identity_active_1d == 2


async def test_one_account_active_in_two_tenants_is_one_active_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Accounts are deployment-wide and tenants are not, so a per-tenant count
    summed across them would add this person once for each."""
    await _other_tenant(session_factory)
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(session_factory, claimed_by=[someone])
    await _chat_account_speaks(
        session_factory, claimed_by=[someone], tenant_id=OTHER_TENANT
    )

    counts = await collect_usage(session_factory)

    assert counts.user_active_1d == 1
    assert counts.chat_identity_active_1d == 2


async def test_a_chat_account_two_people_claim_makes_both_active(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    first = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    second = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(session_factory, claimed_by=[first, second])

    counts = await collect_usage(session_factory)

    assert counts.user_active_1d == 2


async def test_activity_older_than_a_day_counts_for_the_week_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    someone = await _account(session_factory, f"{uuid.uuid4().hex[:6]}@example.com")
    await _chat_account_speaks(
        session_factory,
        claimed_by=[someone],
        spoke_at=datetime.now(UTC) - timedelta(days=3),
    )

    counts = await collect_usage(session_factory)

    assert counts.user_active_1d == 0
    assert counts.user_active_7d == 1


async def test_staff_accounts_are_counted_apart(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    for email in (
        "a@sandboxaq.com",
        "b@SandboxQuantum.com",
        "c@eng.sandboxaq.com",
        "d@example.com",
        "e@notsandboxaq.com",
    ):
        await _account(session_factory, f"{uuid.uuid4().hex[:4]}.{email}")

    counts = await collect_usage(session_factory)

    assert counts.user_count == 5
    assert counts.user_internal_count == 3
