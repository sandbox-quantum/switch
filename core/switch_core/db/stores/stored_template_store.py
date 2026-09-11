from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import StoredTemplate


class StoredTemplateStore:
    async def list_all(
        self,
        session: AsyncSession,
        *,
        kind: str | None = None,
    ) -> list[StoredTemplate]:
        stmt = select(StoredTemplate).order_by(StoredTemplate.name)
        if kind is not None:
            stmt = stmt.where(StoredTemplate.kind == kind)
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def get(
        self, session: AsyncSession, template_id: str
    ) -> StoredTemplate | None:
        return await session.get(StoredTemplate, template_id)

    async def create(
        self, session: AsyncSession, template: StoredTemplate
    ) -> StoredTemplate:
        session.add(template)
        await session.flush()
        return template
