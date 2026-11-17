from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import IdentitySession, User
from switch_core.db.stores.identity_session_store import (
    IDENTITY_SESSION_HORIZON,
    IdentitySessionConflict,
    IdentitySessionStore,
)
from switch_core.gateway.auth import SESSION_MAX_AGE
from switch_core.retention.service import SETTLED_GRACE, prune_identity_sessions

NOW = datetime(2026, 11, 17, 12, 0, tzinfo=UTC)


async def _user(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        user = User(name="Ada", email=f"{uuid.uuid4().hex}@example.test", role="user")
        session.add(user)
        await session.commit()
        return user.id


async def _record(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    session_id: str,
    *,
    followed: bool = True,
    now: datetime = NOW,
) -> str:
    async with session_factory() as session:
        row_id = await IdentitySessionStore().record(
            session,
            user_id=user_id,
            provider="workos",
            session_id=session_id,
            followed=followed,
            now=now,
        )
        await session.commit()
        return row_id


def test_rows_outlast_every_session_cookie_and_the_grace() -> None:
    assert IDENTITY_SESSION_HORIZON >= SESSION_MAX_AGE + SETTLED_GRACE


async def test_a_live_session_signed_in_to_again_is_the_same_row(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    first = await _record(session_factory, user_id, "session_A", followed=False)
    later = NOW + timedelta(minutes=3)
    again = await _record(session_factory, user_id, "session_A", now=later)
    assert again == first
    async with session_factory() as session:
        row = await IdentitySessionStore().get(session, first)
    assert row is not None
    assert row.checked_at == later
    assert row.followed


async def test_an_ended_session_handed_out_again_gets_a_new_row(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Cookies from before a sign-out name the ended row, which stays ended."""
    user_id = await _user(session_factory)
    first = await _record(session_factory, user_id, "session_B")
    async with session_factory() as session:
        assert await IdentitySessionStore().end(session, [first], NOW) == 1
        await session.commit()
    second = await _record(session_factory, user_id, "session_B")
    assert second != first
    async with session_factory() as session:
        store = IdentitySessionStore()
        assert (await store.get(session, first)).ended_at == NOW  # type: ignore[union-attr]
        assert (await store.get(session, second)).ended_at is None  # type: ignore[union-attr]


async def test_a_session_live_under_someone_else_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _user(session_factory)
    eve = await _user(session_factory)
    await _record(session_factory, ada, "session_C")
    async with session_factory() as session:
        with pytest.raises(IdentitySessionConflict):
            await IdentitySessionStore().record(
                session,
                user_id=eve,
                provider="workos",
                session_id="session_C",
                followed=True,
                now=NOW,
            )


async def test_one_check_is_claimed_however_many_ask(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    row_id = await _record(session_factory, user_id, "session_D")
    later = NOW + timedelta(minutes=6)
    store = IdentitySessionStore()
    async with session_factory() as session:
        claimed = await store.claim_check(
            session, row_id, checked_before=later - timedelta(minutes=5), now=later
        )
        await session.commit()
    assert claimed is not None and claimed.session_id == "session_D"
    async with session_factory() as session:
        again = await store.claim_check(
            session, row_id, checked_before=later - timedelta(minutes=5), now=later
        )
    assert again is None


async def test_an_ended_session_is_never_checked(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    row_id = await _record(session_factory, user_id, "session_E")
    store = IdentitySessionStore()
    async with session_factory() as session:
        await store.end(session, [row_id], NOW)
        await session.commit()
    async with session_factory() as session:
        assert (
            await store.claim_check(
                session, row_id, checked_before=NOW + timedelta(days=1), now=NOW
            )
            is None
        )


async def test_live_sessions_are_listed_per_person(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ada = await _user(session_factory)
    eve = await _user(session_factory)
    kept = await _record(session_factory, ada, "session_F1")
    ended = await _record(
        session_factory, ada, "session_F2", now=NOW + timedelta(seconds=1)
    )
    await _record(session_factory, eve, "session_F3")
    store = IdentitySessionStore()
    async with session_factory() as session:
        await store.end(session, [ended], NOW)
        await session.commit()
    async with session_factory() as session:
        live = await store.live_for_user(session, ada)
    assert [row.id for row in live] == [kept]


async def test_rows_go_with_the_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    row_id = await _record(session_factory, user_id, "session_G")
    async with session_factory() as session:
        await session.delete(await session.get(User, user_id))
        await session.commit()
    async with session_factory() as session:
        assert await session.get(IdentitySession, row_id) is None


async def test_retention_prunes_only_what_no_cookie_can_stand_on(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    old = NOW - IDENTITY_SESSION_HORIZON - timedelta(hours=1)
    stale = await _record(session_factory, user_id, "session_H1", now=old)
    long_ended = await _record(
        session_factory, user_id, "session_H2", now=NOW - timedelta(days=2)
    )
    recent = await _record(
        session_factory, user_id, "session_H3", now=NOW - timedelta(days=13)
    )
    async with session_factory() as session:
        await IdentitySessionStore().end(session, [long_ended], old)
        await session.commit()

    await prune_identity_sessions(session_factory, NOW)

    async with session_factory() as session:
        remaining = set(
            await session.scalars(
                select(IdentitySession.id).where(
                    IdentitySession.id.in_([stale, long_ended, recent])
                )
            )
        )
    assert remaining == {recent}
