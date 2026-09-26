"""`TenantStore.create` names the one failure a caller can recover from.

A taken slug can be answered by picking another; any other integrity error
cannot, and must not be mistaken for one — the workspace route retries on the
first and would otherwise retry on everything.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.tenant_store import TenantSlugTaken, TenantStore


async def _create(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, slug: str
) -> None:
    async with tenant_session(session_factory, tenant_id) as session:
        await TenantStore().create(session, Tenant(id=tenant_id, slug=slug, name=slug))
        await session.commit()


class TestCreatingATenant:
    async def test_a_taken_slug_raises_tenant_slug_taken(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _create(session_factory, str(uuid.uuid4()), "taken-slug")

        with pytest.raises(TenantSlugTaken) as raised:
            await _create(session_factory, str(uuid.uuid4()), "taken-slug")

        assert raised.value.slug == "taken-slug"

    async def test_any_other_conflict_is_left_as_it_is(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant_id = str(uuid.uuid4())
        await _create(session_factory, tenant_id, "first-slug")

        with pytest.raises(IntegrityError):
            await _create(session_factory, tenant_id, "second-slug")
