from dataclasses import dataclass

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Template, require_tenant_id

_LIKE_ESCAPE = "\\"


class TemplateNameTaken(ValueError):
    """This owner already has a template by that name.

    A ValueError, so a caller that only knows the house convention still
    catches it, but distinguishable so a router can answer 409 rather than
    folding it in with "not found".
    """


def _like_needle(text: str) -> str:
    escaped = (
        text.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", f"{_LIKE_ESCAPE}%")
        .replace("_", f"{_LIKE_ESCAPE}_")
    )
    return f"%{escaped}%"


@dataclass(frozen=True)
class TemplateListing:
    """One row of the catalogue — everything but the document itself.

    The document is the whole reason a listing has to be careful: reading a
    thousand templates to render a thousand names would drag a thousand
    documents through Postgres and into memory with them. The size is measured
    in the database instead, so a listing costs the same whatever is stored.
    """

    id: str
    owner_id: str
    name: str
    description: str
    kind: str
    version: int
    size_bytes: int
    created_at: object
    updated_at: object


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
                raise TemplateNameTaken(
                    f"You already have a template named '{name}'"
                ) from exc
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
    ) -> list[TemplateListing]:
        """The catalogue, newest first, without the documents.

        Templates are scoped to the caller's tenant: each tenant sees only
        its own templates. Ownership governs who may change or remove one,
        not who may see it within the tenant.
        """
        conditions: list[ColumnElement[bool]] = [
            Template.tenant_id == require_tenant_id(),
        ]
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
            select(
                Template.id,
                Template.owner_id,
                Template.name,
                Template.description,
                Template.kind,
                Template.version,
                # Bytes, not characters — `length()` would undercount anything
                # outside ASCII and disagree with the upload limit.
                func.octet_length(Template.content).label("size_bytes"),
                Template.created_at,
                Template.updated_at,
            )
            .where(*conditions)
            .order_by(Template.created_at.desc(), Template.id.asc())
        )
        result = await session.execute(stmt)
        # By name, not by position: bound positionally, reordering either the
        # select or the dataclass would land a timestamp in `size_bytes` and
        # say nothing about it.
        return [TemplateListing(**row) for row in result.mappings()]

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

        The row is locked for the read-modify-write. Bumping a revision means
        reading the old one first, so two edits racing on an unlocked row would
        both compute the same next number and the later write would drop the
        earlier one silently — the one failure mode worse than an error.

        ``populate_existing`` is what makes the lock worth taking: the caller
        has usually loaded this row already to check ownership, and without it
        the refreshed values are free to lose to the copy sitting in the
        identity map. Locking a row and then computing from a stale read of it
        would be the same lost update, behind a lock that looks like it stopped
        one.
        """
        template = await session.get(
            Template, template_id, with_for_update=True, populate_existing=True
        )
        if template is None:
            raise ValueError(f"Template not found: {template_id}")

        if name is not None and name != template.name:
            # Asked before anything is mutated: a flush that fails the unique
            # constraint deactivates the caller's transaction, and a session in
            # that state cannot even be asked what went wrong.
            clash = await session.execute(
                select(Template.id).where(
                    Template.owner_id == template.owner_id,
                    Template.name == name,
                    Template.id != template_id,
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise TemplateNameTaken(f"You already have a template named '{name}'")
            template.name = name

        if content is not None and content != template.content:
            template.content = content
            template.version += 1
        if description is not None:
            template.description = description
        if kind is not None:
            template.kind = kind

        # Read off the object now: after a failed flush, touching it again can
        # lazy-load against a session that is no longer in a state to answer.
        owner_id, final_name = template.owner_id, template.name

        try:
            # The lock serialises edits to this row, but says nothing about a
            # *different* row claiming the name first, so the constraint is
            # still the arbiter and the savepoint keeps its refusal survivable.
            async with session.begin_nested():
                await session.flush()
        except IntegrityError as exc:
            # Confirm it really is the name before saying so, the same way
            # `create` does. Reporting every constraint this row could ever
            # violate as a name clash would be a confident wrong answer.
            clash = await session.execute(
                select(Template.id).where(
                    Template.owner_id == owner_id,
                    Template.name == final_name,
                    Template.id != template_id,
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise TemplateNameTaken(
                    f"You already have a template named '{final_name}'"
                ) from exc
            raise

        # `updated_at` is computed by Postgres, so the flush leaves it expired.
        # Reload here, where there is a running event loop, rather than leaving
        # the caller to trip a lazy load from synchronous code.
        await session.refresh(template)
        return template

    async def delete(self, session: AsyncSession, template_id: str) -> None:
        template = await session.get(Template, template_id)
        if template is None:
            raise ValueError(f"Template not found: {template_id}")
        await session.delete(template)
        await session.flush()
