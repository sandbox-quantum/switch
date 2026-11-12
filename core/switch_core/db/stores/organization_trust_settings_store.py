from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import OrganizationTrustSettings, Tenant


class OrganizationTrustSettingsStore:
    """Storage for each organization's Switch Trust policy, one row per
    organization (`OrganizationTrustSettings`). Read on a session bound to one
    of the organization's workspaces, or to the organization itself: row-level
    security shows that organization's row and no other's."""

    async def organization_of(
        self, session: AsyncSession, tenant_id: str
    ) -> str | None:
        """The organization `tenant_id` belongs to, on a session bound to it;
        None for a workspace a release from before organizations made."""
        return await session.scalar(
            select(Tenant.organization_id).where(Tenant.id == tenant_id)
        )

    async def get(
        self,
        session: AsyncSession,
        organization_id: str,
        *,
        for_update: bool = False,
    ) -> OrganizationTrustSettings | None:
        query = select(OrganizationTrustSettings).where(
            OrganizationTrustSettings.organization_id == organization_id
        )
        if for_update:
            query = query.with_for_update()
        result = await session.execute(query.execution_options(populate_existing=True))
        return result.scalar_one_or_none()

    async def save(
        self,
        session: AsyncSession,
        *,
        organization_id: str,
        endpoint: str,
        policy_id: str,
        policy_name: str | None,
        api_key_encrypted: str,
        updated_by: str,
    ) -> OrganizationTrustSettings:
        """Connect `policy_id` for the organization, replacing whatever it had."""
        values = {
            "endpoint": endpoint,
            "policy_id": policy_id,
            "policy_name": policy_name,
            "api_key_encrypted": api_key_encrypted,
            "updated_by": updated_by,
        }
        statement = insert(OrganizationTrustSettings).values(
            organization_id=organization_id, **values
        )
        await session.execute(
            statement.on_conflict_do_update(
                index_elements=[OrganizationTrustSettings.organization_id],
                set_={**values, "updated_at": func.now()},
            )
        )
        saved = await self.get(session, organization_id)
        assert saved is not None
        return saved

    async def clear(self, session: AsyncSession, organization_id: str) -> None:
        await session.execute(
            delete(OrganizationTrustSettings).where(
                OrganizationTrustSettings.organization_id == organization_id
            )
        )
