"""The one test everything that reaches into a workspace asks before it
does: whether the workspace is archived (`Tenant.archived_at`).

Kept apart from `workspace_archive.py`, which acts on a workspace as it is
archived and restored, so that every part of Switch that refuses an archived
workspace can import this without importing that.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Tenant

# What anyone refused in an archived workspace is told.
WORKSPACE_ARCHIVED = (
    "This workspace is archived. An organization admin can restore it from "
    "Organization settings › Workspaces."
)


async def is_archived(session: AsyncSession, tenant_id: str) -> bool:
    """Whether `tenant_id` is archived, on a session bound to it."""
    archived_at = await session.scalar(
        select(Tenant.archived_at).where(Tenant.id == tenant_id)
    )
    return archived_at is not None


def archived_since(tenant: Tenant) -> str | None:
    """When `tenant` was archived, as the dashboard is told it; None while it
    is not."""
    return tenant.archived_at.isoformat() if tenant.archived_at is not None else None
