"""Keeping a person's member clients named after them.

A member client takes its display name from the person's `User.name` when
it is created (`ChatsService.member_actor`), and the name is what other
members see beside what the person writes. So when the person renames
themselves, each of their member clients is renamed with them, in every
workspace they can reach: one client per tenant, each behind that tenant's
row-level security, so one tenant session at a time.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import Client
from switch_core.db.session_scope import tenant_session


async def rename_member_clients(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_ids: Iterable[str],
    user_id: str,
    name: str,
) -> None:
    """Give every member client of `user_id` in `tenant_ids` the display name
    `name`. The caller says which tenants: the ones the person can reach, as
    authentication already reads them (`gateway.auth.tenants_bindable_by`)."""
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            await session.execute(
                update(Client)
                .where(Client.user_id == user_id, Client.type == MEMBER_CLIENT_TYPE)
                .values(display_name=name)
            )
            await session.commit()
