from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Template

_LIKE_ESCAPE = "\\"


def _like_needle(text: str) -> str:
    escaped = (
        text.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", f"{_LIKE_ESCAPE}%")
        .replace("_", f"{_LIKE_ESCAPE}_")
    )
    return f"%{escaped}%"


class TemplateStore:
    async def create(self, session: AsyncSession, template: Template) -> Template:
        owner_id, name = template.owner_id, template.name
        try:
            # Savepoint: a duplicate name must not poison the caller's transaction.
            async with session.begin_nested():
                session.add(template)
                await session.flush()
        except IntegrityError as exc:
            clash = await session.execute(
                select(Template.id).where(
                    Template.owner_id == owner_id, Template.name == name
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise ValueError(f"You already have a template named '{name}'") from exc
            raise
        return template

    async def get(self, session: AsyncSession, template_id: str) -> Template | None:
        return await session.get(Template, template_id)

    async def list_all(
        self,
        session: AsyncSession,
        *,
        query: str | None = None,
        kind: str | None = None,
        owner_id: str | None = None,
    ) -> list[Template]:
        """Every template on this server, newest first.

        The registry is a server-wide catalogue: a template is visible to
        everyone regardless of who uploaded it. Ownership governs who may
        change or remove one, not who may see it.
        """
        conditions: list[ColumnElement[bool]] = []
        if query:
            needle = _like_needle(query)
            conditions.append(
                or_(
                    Template.name.ilike(needle, escape=_LIKE_ESCAPE),
                    Template.description.ilike(needle, escape=_LIKE_ESCAPE),
                )
            )
        if kind:
            conditions.append(Template.kind == kind)
        if owner_id:
            conditions.append(Template.owner_id == owner_id)

        stmt = (
            select(Template)
            .where(*conditions)
            .order_by(Template.created_at.desc(), Template.id.asc())
        )
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def update_fields(
        self,
        session: AsyncSession,
        template_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        kind: str | None = None,
        content: str | None = None,
    ) -> Template:
        """Change a stored template. Replacing the content bumps ``version``.

        Metadata-only edits leave the revision alone: the document someone
        fetched is still the document they would fetch now.
        """
        template = await session.get(Template, template_id)
        if template is None:
            raise ValueError(f"Template not found: {template_id}")

        # Checked before anything is mutated: a failed flush would deactivate
        # the caller's transaction, and the unique constraint still backstops a
        # rename that races another one.
        if name is not None and name != template.name:
            clash = await session.execute(
                select(Template.id).where(
                    Template.owner_id == template.owner_id, Template.name == name
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise ValueError(f"You already have a template named '{name}'")
            template.name = name

        if content is not None and content != template.content:
            template.content = content
            template.version += 1
        if description is not None:
            template.description = description
        if kind is not None:
            template.kind = kind

        await session.flush()
        return template

    async def delete(self, session: AsyncSession, template_id: str) -> None:
        template = await session.get(Template, template_id)
        if template is None:
            raise ValueError(f"Template not found: {template_id}")
        await session.delete(template)
        await session.flush()
