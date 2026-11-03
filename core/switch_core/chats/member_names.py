"""Keeping a person's member clients named after them.

A member client takes its display name from the person's `User.name` when
it is created (`ChatsService.member_actor`), and the name is what other
members see beside what the person writes. So when the person renames
themselves, each of their member clients is renamed with them, in every
workspace they can reach: one client per tenant, each behind that tenant's
row-level security, so one tenant session at a time.
"""

from __future__ import annotations

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import Client
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import tenants_bindable_by_user


async def rename_member_clients(
    session_factory: async_sessionmaker[AsyncSession], user_id: str, name: str
) -> None:
    """Give every member client of `user_id` the display name `name`."""
    for tenant_id in await tenants_bindable_by_user(session_factory, user_id):
        async with tenant_session(session_factory, tenant_id) as session:
            await session.execute(
                update(Client)
                .where(Client.user_id == user_id, Client.type == MEMBER_CLIENT_TYPE)
                .values(display_name=name)
            )
            await session.commit()
