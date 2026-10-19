"""Saving the templates a run carries: a version 2 ``template`` resource is
saved for the deployer when the template around it runs.

Each is checked with the rest of the run, before anything exists: a name the
deployer already uses refuses the run. They are saved before the agents and
rooms are created, and deleted again when those then fail, so a run keeps
everything or nothing.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_templates import template_kind
from switch_core.db.models import Template, require_tenant_id
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.template_store import TemplateStore
from switch_core.template_v2 import NestedTemplate

logger = logging.getLogger(__name__)

# The read and write visibility a template resource's `visibility` stands for.
_VISIBILITY: dict[str, tuple[str, str]] = {
    "private": ("private", "private"),
    "shared": ("public", "private"),
}


async def check_names_free(
    session_factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    templates: Sequence[NestedTemplate],
) -> None:
    """Refuse a run whose templates would take a name twice, or one the
    deployer already uses."""
    if not templates:
        return
    names = [t.name for t in templates]
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        raise ValueError(
            f"Nothing was created: this run would save two templates named "
            f"{', '.join(repr(n) for n in twice)}."
        )
    tenant_id = require_tenant_id()
    async with tenant_session(session_factory, tenant_id) as session:
        taken = (
            await session.execute(
                select(Template.name).where(
                    Template.tenant_id == tenant_id,
                    Template.owner_id == owner_id,
                    Template.name.in_(names),
                )
            )
        ).scalars()
        clash = sorted(taken)
    if clash:
        raise ValueError(
            "Nothing was created: this run saves a template named "
            f"{', '.join(repr(n) for n in clash)}, and you already have one by "
            "that name. Rename or delete it, or run with values that name it "
            "differently."
        )


@asynccontextmanager
async def saved(
    session_factory: async_sessionmaker[AsyncSession],
    store: TemplateStore,
    *,
    owner_id: str,
    agent_id: str | None,
    templates: Sequence[NestedTemplate],
) -> AsyncIterator[list[Template]]:
    """Save ``templates`` for ``owner_id`` (``agent_id`` being the agent that
    ran the outer one, None for a person), and delete them again when the
    block raises."""
    if not templates:
        yield []
        return
    tenant_id = require_tenant_id()
    async with tenant_session(session_factory, tenant_id) as session:
        rows = []
        for nested in templates:
            read, write = _VISIBILITY[nested.visibility]
            rows.append(
                await store.create(
                    session,
                    Template(
                        owner_id=owner_id,
                        created_by_agent_id=agent_id,
                        name=nested.name,
                        description=nested.description,
                        kind=template_kind(nested.content),
                        content=nested.content,
                        read_visibility=read,
                        write_visibility=write,
                    ),
                )
            )
        await session.commit()
    try:
        yield rows
    except BaseException:
        await _delete(session_factory, store, tenant_id, rows)
        raise


async def _delete(
    session_factory: async_sessionmaker[AsyncSession],
    store: TemplateStore,
    tenant_id: str,
    rows: Sequence[Template],
) -> None:
    async with tenant_session(session_factory, tenant_id) as session:
        for row in rows:
            try:
                await store.delete(session, row.id)
            except Exception:
                logger.exception(
                    "Could not delete template %s (%s) while undoing a template run",
                    row.name,
                    row.id,
                )
        await session.commit()
