from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    TemplateInstall,
    TemplateInstallResource,
    require_tenant_id,
)


@dataclass(frozen=True)
class NewInstallResource:
    """An agent or room a run created, as its install records it."""

    key: str
    agent_id: str | None
    room_id: str | None
    fingerprints: dict[str, str]


class TemplateInstallStore:
    async def create(
        self,
        session: AsyncSession,
        *,
        owner_id: str,
        source: str,
        template_id: str,
        template_name: str,
        revision: int,
        inputs: dict[str, Any],
        builtins: dict[str, str],
        resources: list[NewInstallResource],
    ) -> TemplateInstall:
        install = TemplateInstall(
            owner_id=owner_id,
            source=source,
            template_id=template_id,
            template_name=template_name,
            revision=revision,
            inputs=inputs,
            builtins=builtins,
        )
        session.add(install)
        await session.flush()
        for resource in resources:
            session.add(
                TemplateInstallResource(
                    install_id=install.id,
                    key=resource.key,
                    agent_id=resource.agent_id,
                    room_id=resource.room_id,
                    fingerprints=resource.fingerprints,
                )
            )
        await session.flush()
        return install

    async def of_template(
        self, session: AsyncSession, template_id: str
    ) -> list[TemplateInstall]:
        """Every install of a template in this tenant, oldest first."""
        result = await session.execute(
            select(TemplateInstall)
            .where(
                TemplateInstall.tenant_id == require_tenant_id(),
                TemplateInstall.template_id == template_id,
            )
            .order_by(TemplateInstall.created_at, TemplateInstall.id)
        )
        return list(result.scalars())

    async def behind(
        self, session: AsyncSession, template_id: str, revision: int
    ) -> list[TemplateInstall]:
        """The installs of a template still at a revision before `revision`,
        oldest first: the ones an update has anything to do for."""
        result = await session.execute(
            select(TemplateInstall)
            .where(
                TemplateInstall.tenant_id == require_tenant_id(),
                TemplateInstall.template_id == template_id,
                TemplateInstall.revision < revision,
            )
            .order_by(TemplateInstall.created_at, TemplateInstall.id)
        )
        return list(result.scalars())

    async def resources(
        self, session: AsyncSession, install_id: str
    ) -> list[TemplateInstallResource]:
        result = await session.execute(
            select(TemplateInstallResource)
            .where(
                TemplateInstallResource.tenant_id == require_tenant_id(),
                TemplateInstallResource.install_id == install_id,
            )
            .order_by(TemplateInstallResource.key)
        )
        return list(result.scalars())

    async def for_agent(
        self, session: AsyncSession, agent_id: str
    ) -> tuple[TemplateInstall, TemplateInstallResource] | None:
        """The install that created an agent, and the agent's entry in it."""
        row = (
            await session.execute(
                select(TemplateInstall, TemplateInstallResource)
                .join(
                    TemplateInstallResource,
                    (TemplateInstallResource.install_id == TemplateInstall.id)
                    & (TemplateInstallResource.tenant_id == TemplateInstall.tenant_id),
                )
                .where(
                    TemplateInstallResource.tenant_id == require_tenant_id(),
                    TemplateInstallResource.agent_id == agent_id,
                )
            )
        ).one_or_none()
        if row is None:
            return None
        return row[0], row[1]

    async def agents_installed_from(
        self, session: AsyncSession, template_id: str, key: str
    ) -> set[str]:
        """The agents created under `key` by any install of `template_id`."""
        result = await session.execute(
            select(TemplateInstallResource.agent_id)
            .join(
                TemplateInstall,
                (TemplateInstallResource.install_id == TemplateInstall.id)
                & (TemplateInstallResource.tenant_id == TemplateInstall.tenant_id),
            )
            .where(
                TemplateInstall.tenant_id == require_tenant_id(),
                TemplateInstall.template_id == template_id,
                TemplateInstallResource.key == key,
                TemplateInstallResource.agent_id.is_not(None),
            )
        )
        return {agent_id for agent_id in result.scalars() if agent_id is not None}

    async def set_fingerprints(
        self, session: AsyncSession, resource_id: str, fingerprints: dict[str, str]
    ) -> None:
        await session.execute(
            update(TemplateInstallResource)
            .where(
                TemplateInstallResource.tenant_id == require_tenant_id(),
                TemplateInstallResource.id == resource_id,
            )
            .values(fingerprints=fingerprints)
        )

    async def move_to_revision(
        self, session: AsyncSession, install_id: str, *, from_revision: int, to: int
    ) -> bool:
        """Move an install to revision `to`, only while it is still at
        `from_revision`: of two servers updating it at once, one moves it and
        the other learns it lost. True when this call moved it."""
        result = await session.execute(
            update(TemplateInstall)
            .where(
                TemplateInstall.tenant_id == require_tenant_id(),
                TemplateInstall.id == install_id,
                TemplateInstall.revision == from_revision,
            )
            .values(revision=to)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]

    async def set_notice(
        self, session: AsyncSession, resource_id: str, notice: str | None
    ) -> None:
        await session.execute(
            update(TemplateInstallResource)
            .where(
                TemplateInstallResource.tenant_id == require_tenant_id(),
                TemplateInstallResource.id == resource_id,
            )
            .values(notice=notice)
        )

    async def notices_for_agents(
        self, session: AsyncSession, agent_ids: list[str]
    ) -> dict[str, str]:
        """What Switch has to tell each of these agents about its template,
        for those it has something to tell."""
        if not agent_ids:
            return {}
        rows = await session.execute(
            select(
                TemplateInstallResource.agent_id, TemplateInstallResource.notice
            ).where(
                TemplateInstallResource.tenant_id == require_tenant_id(),
                TemplateInstallResource.agent_id.in_(agent_ids),
                TemplateInstallResource.notice.is_not(None),
            )
        )
        return {
            agent_id: notice
            for agent_id, notice in rows.tuples()
            if agent_id is not None and notice is not None
        }

    async def templates_of_agents(
        self, session: AsyncSession, agent_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        """The template that created each of these agents, {id, key,
        revision}, for those an install records."""
        if not agent_ids:
            return {}
        rows = await session.execute(
            select(
                TemplateInstallResource.agent_id,
                TemplateInstallResource.key,
                TemplateInstall.template_id,
                TemplateInstall.revision,
            )
            .join(
                TemplateInstall,
                (TemplateInstallResource.install_id == TemplateInstall.id)
                & (TemplateInstallResource.tenant_id == TemplateInstall.tenant_id),
            )
            .where(
                TemplateInstallResource.tenant_id == require_tenant_id(),
                TemplateInstallResource.agent_id.in_(agent_ids),
            )
        )
        return {
            agent_id: {"id": template_id, "key": key, "revision": revision}
            for agent_id, key, template_id, revision in rows.tuples()
            if agent_id is not None
        }
