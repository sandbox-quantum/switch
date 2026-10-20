"""Move GitHub onto service connections, once per tenant, at boot.

GitHub's connections lived in `provider_connections`. This copies each one to
`service_connections`, its ciphertext as it is (the same keyring, the same
JSON), with the account's stable GitHub id and login read from that JSON.

It needs the server's keys, which is why it runs at boot, after key rotation,
rather than as a migration. It runs once per tenant: the tenant's
`tenant_data_moves` row is claimed before anything is copied and commits with
the copy, so a later boot never copies again over what people have changed
since (a disconnect, a removed grant). The old table stays as it is, for the
release that can still be rolled back to.

A row that cannot be read is skipped, never guessed at: it is logged, naming
the tenant and the user but nothing of the value, and counted. That person
sees GitHub as not connected and connects it again. So is a row the new tables
already hold (the marker downgraded away while they stayed), and a second
person linked to a GitHub account someone else's row already has: what is
there wins.

A tenant whose move fails is rolled back, marker and all, and logged; the
other tenants still move, and the failed one is tried again at the next boot.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    ProviderConnection,
    ServiceConnection,
    TenantDataMove,
)
from switch_core.db.session_scope import tenant_session
from switch_core.keys import Keyring

logger = logging.getLogger(__name__)

MOVE = "github_to_service_connections"


async def move_github_connections(
    session_factory: async_sessionmaker[AsyncSession],
    keyring: Keyring,
    tenant_ids: list[str],
) -> None:
    """Carry out the move in every tenant that has not had it."""
    failed: list[str] = []
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            if await session.get(TenantDataMove, (tenant_id, MOVE)) is not None:
                continue
            marker = TenantDataMove(tenant_id=tenant_id, name=MOVE, details={})
            session.add(marker)
            try:
                await session.flush()
            except IntegrityError:
                # Another boot claimed this tenant first, and has moved it.
                await session.rollback()
                continue
            try:
                counts = await _move(session, keyring, tenant_id)
                marker.details = counts
                await session.commit()
            except Exception:
                await session.rollback()
                logger.exception(
                    "GitHub move onto service connections failed in tenant %s; "
                    "nothing was moved there, and the next boot tries again.",
                    tenant_id,
                )
                failed.append(tenant_id)
                continue
        skipped = sum(v for k, v in counts.items() if k.endswith("_skipped"))
        log = logger.warning if skipped else logger.info
        log("GitHub moved onto service connections in tenant %s: %s", tenant_id, counts)
    if failed:
        logger.error(
            "GitHub move failed in %d tenant(s), whose people see GitHub as not "
            "connected until it succeeds: %s",
            len(failed),
            ", ".join(failed),
        )


async def _move(
    session: AsyncSession, keyring: Keyring, tenant_id: str
) -> dict[str, int]:
    counts = {"connections": 0, "connections_skipped": 0}

    existing = {
        row.user_id: row.account_id
        for row in await session.scalars(
            select(ServiceConnection).where(
                ServiceConnection.tenant_id == tenant_id,
                ServiceConnection.service == "github",
            )
        )
    }
    accounts: dict[str, str] = dict(existing)
    rows = await session.scalars(
        select(ProviderConnection).where(
            ProviderConnection.tenant_id == tenant_id,
            ProviderConnection.provider == "github",
        )
    )
    for row in rows:
        identity = _identity(keyring, row.encrypted_credential)
        if identity is None:
            logger.error(
                "GitHub connection not moved, unreadable: tenant=%s user=%s. "
                "They must connect GitHub again.",
                tenant_id,
                row.user_id,
            )
            counts["connections_skipped"] += 1
            continue
        account_id, login = identity
        if row.user_id in existing:
            logger.warning(
                "GitHub connection not moved, already there: tenant=%s user=%s.",
                tenant_id,
                row.user_id,
            )
            counts["connections_skipped"] += 1
            continue
        holder = next((u for u, a in accounts.items() if a == account_id), None)
        if holder is not None:
            logger.error(
                "GitHub connection not moved: tenant=%s user=%s links the GitHub "
                "account user=%s already has. They must connect another account.",
                tenant_id,
                row.user_id,
                holder,
            )
            counts["connections_skipped"] += 1
            continue
        session.add(
            ServiceConnection(
                tenant_id=tenant_id,
                user_id=row.user_id,
                service="github",
                status="active",
                consent="write",
                granted_scopes=[],
                account_id=account_id,
                external_identity=login,
                encrypted_secret=row.encrypted_credential,
                secret_revision=1,
                error_code=None,
            )
        )
        accounts[row.user_id] = account_id
        counts["connections"] += 1
    await session.flush()
    return counts


def _identity(keyring: Keyring, encrypted: str) -> tuple[str, str] | None:
    """The account's stable id and login, or None when the row cannot be read."""
    try:
        values: Any = json.loads(keyring.decrypt(encrypted))
    except Exception:
        return None
    if not isinstance(values, dict):
        return None
    user_id = values.get("user_id")
    login = values.get("login")
    if type(user_id) is not int or not isinstance(login, str) or not login:
        return None
    return str(user_id), login
