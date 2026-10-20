"""Timed upkeep for service tokens: revoke what lost its grant, prune old records.

The broker revokes at once after each access change it makes itself. This
catches the rest, every five minutes: an agent deleted (its grants go by
cascade), an owner removed from the workspace, a vendor that could not be
reached the first time. Without it such a token would stay usable until it
expired, up to an hour. Issuance records are kept for
`service_token_retention_days`, then pruned, hourly.

Tenants are worked through one at a time, each bound before it is touched,
like every other background task that spans them.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import ServiceBroker
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.tenant_context import no_tenant

logger = logging.getLogger(__name__)

# How long a token whose grant went outside the broker (an agent deleted, an
# owner removed) can stay usable before it is revoked. A pass over a workspace
# that holds no token is one read, so the cost is the number of workspaces.
REVOCATION_EVERY_SECONDS = 300.0
PRUNE_EVERY_SECONDS = 3600.0


async def maintain_once(
    session_factory: async_sessionmaker[AsyncSession],
    broker: ServiceBroker,
    *,
    prune: bool,
) -> None:
    """One pass over every tenant: a revocation batch, and a prune if asked."""
    for tenant_id in await all_tenant_ids(session_factory):
        try:
            async with tenant_session(session_factory, tenant_id) as session:
                if await broker.revoke_pending(session, ()):
                    logger.warning(
                        "Service tokens in tenant %s are still waiting to be revoked",
                        tenant_id,
                    )
                if prune:
                    await broker.prune(session)
        except Exception:
            # One tenant's failure must not stop the others' tokens being revoked.
            logger.exception("Service token upkeep failed for tenant %s", tenant_id)


async def maintenance_loop(
    session_factory: async_sessionmaker[AsyncSession], broker: ServiceBroker
) -> None:
    with no_tenant():
        since_prune = PRUNE_EVERY_SECONDS
        while True:
            await asyncio.sleep(REVOCATION_EVERY_SECONDS)
            since_prune += REVOCATION_EVERY_SECONDS
            prune = since_prune >= PRUNE_EVERY_SECONDS
            try:
                await maintain_once(session_factory, broker, prune=prune)
            except Exception:
                logger.exception("Service token upkeep failed")
            else:
                if prune:
                    since_prune = 0.0
