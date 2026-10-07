"""Following placements and sealed logins changed outside this process.

The management routes tell Core and the controllers of each change in-process
as they commit it. A change committed by another process is not heard of in
here, so Core reads the rows back every `RELOAD_SECONDS`: an agent placed, moved, set running or stopped,
or removed is bound or unbound and its controller told its assignment changed,
and a login sealed at a revision its controller was not told of is announced
through `ManagementService.provider_credential_changed`, as the routes do.

A reload that overlaps a change the routes make in-process is dropped rather
than applied: what it read may predate that change. The next one applies.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import SealedProviderCredential
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.management.bindings import read_placements
from switch_core.management.service import ManagementService

logger = logging.getLogger(__name__)

RELOAD_SECONDS = 10.0


async def reload_placements(
    session_factory: async_sessionmaker[AsyncSession], service: ManagementService
) -> int:
    """Bring Core's bindings in step with the placed definitions, and tell
    each controller that gained or lost an agent. Returns how many
    controllers that was."""
    presence = service.presence
    epoch = presence.binding_epoch
    placements = await read_placements(
        session_factory=session_factory,
        definitions=service.definitions,
        controllers=service.controllers,
    )
    if presence.binding_epoch != epoch:
        logger.info("A placement changed while reloading them; reloading next round")
        return 0
    changed = presence.reconcile(placements.bindings)
    for controller_id in placements.revoked:
        if not presence.is_revoked(controller_id):
            presence.revoke_controller(controller_id)
    for controller_id, tenant_id in sorted(changed.items()):
        revision = placements.revisions.get(controller_id)
        if revision is None:
            async with tenant_session(session_factory, tenant_id) as session:
                controller = await service.controllers.get(
                    session, tenant_id, controller_id
                )
            if controller is None:
                continue
            revision = controller.assignment_revision
        service.notifier.assignment_changed(controller_id, revision)
    if changed:
        logger.info(
            "Reloaded placements changed outside Core on controller(s) %s",
            ", ".join(sorted(changed)),
        )
    return len(changed)


async def read_login_revisions(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[tuple[str, str], int]:
    """The revision of every sealed login, by controller and provider."""
    revisions: dict[tuple[str, str], int] = {}
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            rows = await session.execute(
                select(
                    SealedProviderCredential.controller_id,
                    SealedProviderCredential.provider,
                    SealedProviderCredential.revision,
                ).where(SealedProviderCredential.tenant_id == tenant_id)
            )
            for controller_id, provider, revision in rows:
                revisions[(controller_id, provider)] = revision
    return revisions


async def reload_logins(
    session_factory: async_sessionmaker[AsyncSession], service: ManagementService
) -> int:
    """Announce every sealed login revision its controller was not told of.
    Returns how many."""
    return service.announce_login_revisions(await read_login_revisions(session_factory))
