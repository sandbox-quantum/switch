from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TenantJoinDomain


class JoinDomainAlreadyAdded(Exception):
    """The bound tenant is already open to this domain."""


class JoinDomainNotFound(Exception):
    """The bound tenant is not open to this domain."""


class JoinDomainStore:
    """The e-mail domains a tenant lets people join from without an invitation.

    Every read names its tenant as well as relying on the policy: the same
    methods run on the owner connection the policy does not apply to, and a
    read that leaned on row-level security alone would answer for every
    tenant there.
    """

    async def list_for_tenant(
        self, session: AsyncSession, tenant_id: str
    ) -> list[TenantJoinDomain]:
        result = await session.execute(
            select(TenantJoinDomain)
            .where(TenantJoinDomain.tenant_id == tenant_id)
            .order_by(TenantJoinDomain.domain)
        )
        return list(result.scalars().all())

    async def is_open_to(
        self, session: AsyncSession, tenant_id: str, domain: str
    ) -> bool:
        result = await session.execute(
            select(TenantJoinDomain.domain).where(
                TenantJoinDomain.tenant_id == tenant_id,
                TenantJoinDomain.domain == domain.lower(),
            )
        )
        return result.scalar_one_or_none() is not None

    async def add(
        self, session: AsyncSession, *, domain: str, created_by: str
    ) -> TenantJoinDomain:
        """Open the bound tenant to `domain`, raising if it already is."""
        row = TenantJoinDomain(domain=domain.lower(), created_by=created_by)
        try:
            async with session.begin_nested():
                session.add(row)
                await session.flush()
        except IntegrityError as exc:
            raise JoinDomainAlreadyAdded(domain) from exc
        return row

    async def remove(self, session: AsyncSession, tenant_id: str, domain: str) -> None:
        result = await session.execute(
            delete(TenantJoinDomain)
            .where(
                TenantJoinDomain.tenant_id == tenant_id,
                TenantJoinDomain.domain == domain.lower(),
            )
            .returning(TenantJoinDomain.domain)
        )
        if result.scalar_one_or_none() is None:
            raise JoinDomainNotFound(domain)
