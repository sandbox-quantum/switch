"""BrowserHandoffStore: one-time sign-ins Switch Console hands a browser.

Against real Postgres, because what matters is what the database decides:
expiry against its clock, a code spent by exactly one `UPDATE`, the mint
limit counted under a lock, and which rows a prune leaves.
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import BrowserHandoff, User
from switch_core.db.stores import browser_handoff_store
from switch_core.db.stores.browser_handoff_store import (
    HANDOFF_TTL,
    MINT_LIMIT,
    MINT_WINDOW,
    BrowserHandoffRateLimited,
    BrowserHandoffStore,
)

_MAX_AGE = timedelta(days=14)
_STORE = BrowserHandoffStore(session_max_age=_MAX_AGE)
_SIGNED_IN = datetime.now(UTC) - timedelta(hours=2)


async def _user(factory: async_sessionmaker[AsyncSession]) -> str:
    async with factory() as session:
        user = User(name="Ada", email=f"ada-{uuid.uuid4().hex[:8]}@test", role="user")
        session.add(user)
        await session.commit()
        return user.id


async def _mint(
    factory: async_sessionmaker[AsyncSession],
    user_id: str,
    *,
    console_sid: str | None = "console-sid",
) -> str:
    async with factory() as session:
        minted = await _STORE.mint(
            session,
            user_id=user_id,
            workspace_claim="tenant-a",
            next_path="/rooms",
            auth_time=_SIGNED_IN,
            session_version=3,
            console_sid=console_sid,
            identity_session=None,
        )
        await session.commit()
    return minted.code


async def _redeem(
    factory: async_sessionmaker[AsyncSession], code: str, browser_sid: str = "b-1"
) -> BrowserHandoff | None:
    async with factory() as session:
        row = await _STORE.redeem(session, code, browser_sid=browser_sid)
        await session.commit()
        return row


async def _rows(factory: async_sessionmaker[AsyncSession]) -> list[BrowserHandoff]:
    async with factory() as session:
        return list(await session.scalars(select(BrowserHandoff)))


async def _age(factory: async_sessionmaker[AsyncSession], by: timedelta) -> None:
    """Move every row's times back by `by`, as if minted that long ago."""
    async with factory() as session:
        await session.execute(
            update(BrowserHandoff).values(
                created_at=BrowserHandoff.created_at - by,
                expires_at=BrowserHandoff.expires_at - by,
            )
        )
        await session.commit()


async def test_a_code_is_stored_only_as_its_hash_and_carries_the_session(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    async with session_factory() as session:
        minted = await _STORE.mint(
            session,
            user_id=user_id,
            workspace_claim="tenant-a",
            next_path="/rooms/r1?tab=docs#top",
            auth_time=_SIGNED_IN,
            session_version=3,
            console_sid="console-sid",
            identity_session="identity-session-row",
        )
        now = await session.scalar(select(func.now()))
        await session.commit()

    assert len(minted.code) >= 43
    assert minted.expires_at == now + HANDOFF_TTL
    [row] = await _rows(session_factory)
    assert row.code_hash == hashlib.sha256(minted.code.encode()).hexdigest()
    assert minted.code not in {
        str(value) for value in row.__dict__.values() if value is not None
    }
    assert (
        row.user_id,
        row.workspace_claim,
        row.next_path,
        row.auth_time,
        row.session_version,
        row.console_sid,
        row.identity_session,
        row.browser_sid,
        row.used_at,
    ) == (
        user_id,
        "tenant-a",
        "/rooms/r1?tab=docs#top",
        _SIGNED_IN,
        3,
        "console-sid",
        "identity-session-row",
        None,
        None,
    )


async def test_a_code_is_redeemed_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(session_factory, await _user(session_factory))

    async with session_factory() as session:
        assert await _STORE.peek(session, code) is not None
        assert await _STORE.peek(session, code) is not None

    first = await _redeem(session_factory, code, browser_sid="browser-sid")
    assert first is not None
    assert first.browser_sid == "browser-sid"
    assert first.used_at is not None
    assert await _redeem(session_factory, code) is None
    async with session_factory() as session:
        assert await _STORE.peek(session, code) is None


async def test_of_two_redemptions_racing_exactly_one_wins(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(session_factory, await _user(session_factory))
    results = await asyncio.gather(
        *(_redeem(session_factory, code, browser_sid=f"b-{i}") for i in range(5))
    )
    assert sum(result is not None for result in results) == 1


async def test_a_code_that_was_never_minted_finds_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _mint(session_factory, await _user(session_factory))
    async with session_factory() as session:
        assert await _STORE.peek(session, "not-a-code") is None
    assert await _redeem(session_factory, "not-a-code") is None


async def test_an_expired_code_can_be_neither_peeked_nor_redeemed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    code = await _mint(session_factory, await _user(session_factory))
    await _age(session_factory, HANDOFF_TTL + timedelta(seconds=1))

    async with session_factory() as session:
        assert await _STORE.peek(session, code) is None
    assert await _redeem(session_factory, code) is None


async def test_a_person_may_mint_only_so_many_codes_a_minute(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    other = await _user(session_factory)
    for _ in range(MINT_LIMIT):
        await _mint(session_factory, user_id)

    with pytest.raises(BrowserHandoffRateLimited):
        await _mint(session_factory, user_id)
    # Someone else is counted on their own.
    await _mint(session_factory, other)

    await _age(session_factory, timedelta(seconds=61))
    await _mint(session_factory, user_id)


async def _minted_ago(
    factory: async_sessionmaker[AsyncSession], *ages: timedelta
) -> None:
    """Set when the rows were minted, oldest first: the nth row `ages[n]`
    ago."""
    async with factory() as session:
        ids = list(
            await session.scalars(
                select(BrowserHandoff.id).order_by(BrowserHandoff.created_at)
            )
        )
        assert len(ids) == len(ages)
        for row_id, age in zip(ids, ages, strict=True):
            await session.execute(
                update(BrowserHandoff)
                .where(BrowserHandoff.id == row_id)
                .values(created_at=func.now() - age)
            )
        await session.commit()


async def test_a_refusal_says_how_long_until_the_oldest_counted_mint_leaves_the_window(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    for _ in range(MINT_LIMIT):
        await _mint(session_factory, user_id)
    oldest = timedelta(seconds=30)
    await _minted_ago(
        session_factory, oldest, *[timedelta(seconds=10)] * (MINT_LIMIT - 1)
    )

    with pytest.raises(BrowserHandoffRateLimited) as refused:
        await _mint(session_factory, user_id)
    wait = refused.value.retry_after
    assert MINT_WINDOW - oldest - timedelta(seconds=5) < wait <= MINT_WINDOW - oldest

    # Not before that: a little short of it, the oldest still counts.
    await _age(session_factory, wait - timedelta(seconds=5))
    with pytest.raises(BrowserHandoffRateLimited):
        await _mint(session_factory, user_id)
    # Then it has left the window, and the other mints still count.
    await _age(session_factory, timedelta(seconds=6))
    await _mint(session_factory, user_id)
    with pytest.raises(BrowserHandoffRateLimited):
        await _mint(session_factory, user_id)


async def test_over_the_limit_the_wait_is_until_enough_mints_leave_the_window(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With more mints in the window than the limit allows, as after the limit
    is lowered, the next is allowed once fewer than the limit are left."""
    user_id = await _user(session_factory)
    for _ in range(3):
        await _mint(session_factory, user_id)
    await _minted_ago(
        session_factory,
        timedelta(seconds=50),
        timedelta(seconds=40),
        timedelta(seconds=5),
    )
    monkeypatch.setattr(browser_handoff_store, "MINT_LIMIT", 2)

    with pytest.raises(BrowserHandoffRateLimited) as refused:
        await _mint(session_factory, user_id)

    # The second oldest, minted 40 seconds ago, leaves it 20 seconds from now.
    wait = refused.value.retry_after
    assert timedelta(seconds=15) < wait <= timedelta(seconds=20)


async def test_a_burst_sent_at_once_is_counted_exactly(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)

    async def attempt() -> bool:
        try:
            await _mint(session_factory, user_id)
        except BrowserHandoffRateLimited:
            return False
        return True

    results = await asyncio.gather(*(attempt() for _ in range(MINT_LIMIT + 5)))
    assert sum(results) == MINT_LIMIT


async def test_a_mint_deletes_the_rows_nothing_needs_any_more(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    unused = await _mint(session_factory, user_id)
    linked = await _mint(session_factory, user_id)
    await _redeem(session_factory, linked, browser_sid="linked-browser")
    unlinked = await _mint(session_factory, user_id, console_sid=None)
    await _redeem(session_factory, unlinked, browser_sid="unlinked-browser")
    await _age(session_factory, timedelta(minutes=59))

    fresh = await _mint(session_factory, user_id)
    assert len(await _rows(session_factory)) == 4, "nothing is an hour past expiry yet"

    await _age(session_factory, timedelta(minutes=3))
    await _mint(session_factory, user_id)
    kept = {row.code_hash for row in await _rows(session_factory)}
    hashes = {
        code: hashlib.sha256(code.encode()).hexdigest()
        for code in (unused, linked, unlinked, fresh)
    }
    # The unused code and the one with no minting session to sign out of go;
    # the one linking a browser session that could still be live stays.
    assert hashes[unused] not in kept
    assert hashes[unlinked] not in kept
    assert hashes[linked] in kept
    assert hashes[fresh] in kept

    # Once that browser session could not be live any more, it goes too.
    async with session_factory() as session:
        await session.execute(
            update(BrowserHandoff)
            .where(BrowserHandoff.code_hash == hashes[linked])
            .values(auth_time=datetime.now(UTC) - _MAX_AGE - timedelta(minutes=1))
        )
        await session.commit()
    await _mint(session_factory, user_id)
    assert hashes[linked] not in {row.code_hash for row in await _rows(session_factory)}


async def test_the_sessions_a_session_opened_are_found_by_its_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    redeemed = await _mint(session_factory, user_id, console_sid="console-sid")
    await _redeem(session_factory, redeemed, browser_sid="browser-sid")
    await _mint(session_factory, user_id, console_sid="console-sid")  # never redeemed
    other = await _mint(session_factory, user_id, console_sid="another-console")
    await _redeem(session_factory, other, browser_sid="another-browser")

    async with session_factory() as session:
        opened = await _STORE.lock_sessions_opened_by(session, ["console-sid"])
    assert [(o.session_id, o.signed_in_at) for o in opened] == [
        ("browser-sid", _SIGNED_IN)
    ]


async def test_deleting_the_account_deletes_its_codes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id = await _user(session_factory)
    await _mint(session_factory, user_id)
    async with session_factory() as session:
        user = await session.get(User, user_id)
        await session.delete(user)
        await session.commit()
    assert await _rows(session_factory) == []
