"""Move GitHub onto service connections, once per tenant, at boot.

GitHub's connections lived in `provider_connections` and the installation
tokens issued to cloud agents in `github_issued_tokens`. This copies them:

- each GitHub connection to `service_connections`, its ciphertext as it is
  (the same keyring, the same JSON), with the account's stable GitHub id and
  login read from that JSON;
- a write grant for each live cloud launch, on its installation and
  repository, so its agent keeps working;
- each unexpired token to `service_token_issuances`, with its hash. A token
  today's rules no longer accept (its launch stopped or moved on, its owner's
  connection not moved) arrives already queued for revocation.

It needs the server's keys, which is why it runs at boot, after key rotation,
rather than as a migration. It runs once per tenant: the tenant's
`tenant_data_moves` row is claimed before anything is copied and commits with
the copy, so a later boot never copies again over what people have changed
since (a disconnect, a removed grant). The old tables stay as they are, for
the release that can still be rolled back to.

A row that cannot be read is skipped, never guessed at: it is logged, naming
the tenant and the user but nothing of the value, and counted. That person
sees GitHub as not connected and connects it again.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    GitHubIssuedToken,
    HostedLaunch,
    ProviderConnection,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    TenantDataMove,
)
from switch_core.db.session_scope import tenant_session
from switch_core.keys import Keyring

logger = logging.getLogger(__name__)

MOVE = "github_to_service_connections"
# What a cloud launch's token has always carried.
WRITE_REACH = {"permissions": {"contents": "write", "pull_requests": "write"}}


async def move_github_connections(
    session_factory: async_sessionmaker[AsyncSession],
    keyring: Keyring,
    tenant_ids: list[str],
) -> None:
    """Carry out the move in every tenant that has not had it."""
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
            counts = await _move(session, keyring, tenant_id)
            marker.details = counts
            await session.commit()
        skipped = sum(v for k, v in counts.items() if k.endswith("_skipped"))
        log = logger.warning if skipped else logger.info
        log("GitHub moved onto service connections in tenant %s: %s", tenant_id, counts)


async def _move(
    session: AsyncSession, keyring: Keyring, tenant_id: str
) -> dict[str, int]:
    counts = {
        "connections": 0,
        "connections_skipped": 0,
        "grants": 0,
        "grants_skipped": 0,
        "tokens": 0,
        "tokens_queued": 0,
        "tokens_skipped": 0,
    }

    accounts: dict[str, str] = {}
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

    launches = {
        launch.id: launch
        for launch in await session.scalars(
            select(HostedLaunch).where(HostedLaunch.tenant_id == tenant_id)
        )
    }
    grants: dict[str, ServiceGrant] = {}
    granted_agents: set[str] = set()
    for launch in launches.values():
        if launch.agent_id is None or launch.state in ("deleting", "deleted"):
            continue
        resources = _launch_resources(launch)
        owner_account = accounts.get(launch.owner_id)
        agent = await session.scalar(
            select(Agent.id).where(
                Agent.tenant_id == tenant_id, Agent.id == launch.agent_id
            )
        )
        if (
            resources is None
            or owner_account is None
            or agent is None
            or launch.agent_id in granted_agents
        ):
            logger.error(
                "GitHub grant not made for cloud launch: tenant=%s launch=%s "
                "agent=%s (%s). Its owner must grant GitHub to the agent.",
                tenant_id,
                launch.id,
                launch.agent_id,
                "no repository"
                if resources is None
                else "connection not moved"
                if owner_account is None
                else "agent missing"
                if agent is None
                else "agent already granted",
            )
            counts["grants_skipped"] += 1
            continue
        grant = ServiceGrant(
            tenant_id=tenant_id,
            agent_id=launch.agent_id,
            owner_id=launch.owner_id,
            service="github",
            access="write",
            tool_mode="deny",
            tools=[],
            resources=resources,
            account_id=owner_account,
            created_by=launch.owner_id,
        )
        session.add(grant)
        grants[launch.id] = grant
        granted_agents.add(launch.agent_id)
        counts["grants"] += 1
    await session.flush()

    now = datetime.now(UTC)
    tokens = await session.scalars(
        select(GitHubIssuedToken).where(
            GitHubIssuedToken.tenant_id == tenant_id,
            GitHubIssuedToken.expires_at > now,
        )
    )
    for token in tokens:
        try:
            plaintext = keyring.decrypt(token.encrypted_token)
        except Exception as error:
            logger.error(
                "GitHub token record not moved, unreadable: tenant=%s launch=%s "
                "error_type=%s. It expires by %s.",
                tenant_id,
                token.launch_id,
                type(error).__name__,
                token.expires_at.isoformat(),
            )
            counts["tokens_skipped"] += 1
            continue
        issued_by = launches.get(token.launch_id)
        issued_under = grants.get(token.launch_id)
        live = (
            issued_by is not None
            and issued_under is not None
            and not token.revoke_requested
            and issued_by.revision == token.launch_revision
            and issued_by.desired_state == "running"
            and issued_by.state != "error"
        )
        session.add(
            ServiceTokenIssuance(
                tenant_id=tenant_id,
                grant_id=issued_under.id
                if issued_under is not None
                else f"launch:{token.launch_id}",
                agent_id=(
                    issued_by.agent_id
                    if issued_by is not None and issued_by.agent_id
                    else f"launch:{token.launch_id}"
                ),
                owner_id=token.owner_id,
                service="github",
                principal="agent_key",
                controller_id=None,
                permissions=WRITE_REACH,
                resources=(
                    {} if issued_by is None else _launch_resources(issued_by) or {}
                ),
                expires_at=token.expires_at,
                token_sha256=hashlib.sha256(plaintext.encode()).hexdigest(),
                encrypted_token=token.encrypted_token,
                revoke_requested=not live,
                attempts=token.attempts,
                claim_until=None,
            )
        )
        counts["tokens"] += 1
        if not live:
            counts["tokens_queued"] += 1
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


def _launch_resources(launch: HostedLaunch) -> dict[str, Any] | None:
    installation_id = launch.spec.get("installation_id")
    repository_id = launch.spec.get("repository_id")
    if type(installation_id) is not int or type(repository_id) is not int:
        return None
    return {"installation_id": installation_id, "repository_ids": [repository_id]}
