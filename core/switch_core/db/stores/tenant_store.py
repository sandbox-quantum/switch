from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Tenant

# Postgres's default name for `tenants.slug`'s unique constraint, from the
# migration that created the table.
_SLUG_CONSTRAINT = "tenants_slug_key"


class TenantSlugTaken(Exception):
    """The slug belongs to another tenant. Nothing was written."""

    def __init__(self, slug: str) -> None:
        super().__init__(f"Tenant slug {slug!r} is taken")
        self.slug = slug


def _violated_constraint(err: IntegrityError) -> str | None:
    # asyncpg's own exception, which carries the constraint name, is the
    # cause of the DBAPI adapter's.
    return getattr(getattr(err.orig, "__cause__", None), "constraint_name", None)


class TenantStore:
    """Writes tenants. Reading which ones exist is not a store's question.

    There was a `get_all_ids` here and it is gone. `tenants` carries the same
    policy as every other scoped table, comparing on `id`, so a session sees
    exactly its own row and no store method can enumerate them — the previous
    one only appeared to because every caller handed it a session connected as
    the tables' owner. The enumeration is `all_tenant_ids` in
    `db/tenant_lookup.py`, one of the seven `SECURITY DEFINER` functions that
    are the whole exemption from row-level security, and it takes a session
    factory rather than a session precisely because there is no session it
    could correctly run on.
    """

    async def create(self, session: AsyncSession, tenant: Tenant) -> Tenant:
        """Insert a tenant row.

        Called from `ClientLifecycleService.create_tenant`, the one path that
        creates a tenant in the running application and provisions what it
        needs in the same call, rather than a row appearing — today, only by
        direct SQL — with nothing to notice it until the next restart.

        The session it is handed must be bound to the tenant being created:
        `tenants`' policy compares on `id`, so that binding is what satisfies
        `with check`, and no other one can.

        A taken slug raises `TenantSlugTaken` — the one failure a caller can
        answer by picking another slug. Every other integrity error propagates
        as it is.
        """
        session.add(tenant)
        try:
            await session.flush()
        except IntegrityError as err:
            if _violated_constraint(err) == _SLUG_CONSTRAINT:
                raise TenantSlugTaken(tenant.slug) from err
            raise
        return tenant
