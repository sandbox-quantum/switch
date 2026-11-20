"""Two admins removing themselves from a workspace at the same moment.

Against real Postgres, with the app `test_tenant_api_routes.py` builds. The
last-admin rule keeps one of them, and the other is told so with a 409, not a
deadlock: every removal locks the admins' rows before the member's own.
"""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TenantMember
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)


class _BothCountTogether(UserStore):
    """Holds each removal at its admin count until both have reached it, so
    each has taken whatever it locks first before either counts."""

    def __init__(self) -> None:
        self.both = asyncio.Barrier(2)

    async def lock_admins(self, session: AsyncSession) -> int:
        async with asyncio.timeout(10):
            await self.both.wait()
        return await super().lock_admins(session)


async def test_two_admins_leaving_at_once_leave_one_and_tell_the_other(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _make_tenant(session_factory, TENANT_A)
    first = await _make_member(
        session_factory, name="first-admin", tenant_id=TENANT_A, role="admin"
    )
    second = await _make_member(
        session_factory, name="second-admin", tenant_id=TENANT_A, role="admin"
    )
    app = _app(session_factory)
    store = _BothCountTogether()
    app.dependency_overrides[gw_deps.get_user_store] = lambda: store

    async def leave(user_id: str, name: str) -> int:
        async with _client(
            app, _token(user_id, f"{name}@example.invalid", TENANT_A)
        ) as client:
            response = await client.delete(f"/tenants/{TENANT_A}/members/{user_id}")
        return response.status_code

    statuses = await asyncio.gather(
        leave(first, "first-admin"), leave(second, "second-admin")
    )

    assert sorted(statuses) == [200, 409]
    async with session_factory() as session:
        remaining = [
            user_id
            for user_id in (first, second)
            if await session.get(TenantMember, (TENANT_A, user_id)) is not None
        ]
    assert len(remaining) == 1
