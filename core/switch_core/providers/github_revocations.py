import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import delete, exists, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import (
    GitHubIssuedToken,
    HostedLaunch,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.providers.github import GitHubConnections
from switch_core.providers.github_installation import (
    GitHubInstallationCredentials,
    RepositoryCredential,
)

logger = logging.getLogger(__name__)
ACCESS_WARNING = "Some GitHub repository access may remain for up to 1 hour."


def remember_repository_token(
    session: AsyncSession,
    launch: HostedLaunch,
    credential: RepositoryCredential,
    config: SwitchConfig,
) -> GitHubIssuedToken:
    record = GitHubIssuedToken(
        tenant_id=require_tenant_id(),
        id=str(uuid4()),
        owner_id=launch.owner_id,
        launch_id=launch.id,
        launch_revision=launch.revision,
        encrypted_token=encrypt_token(credential.token, config.jwt_secret_key),
        expires_at=credential.expires_at,
        revoke_requested=False,
        attempts=0,
    )
    session.add(record)
    return record


async def queue_revocation(session: AsyncSession, conditions: tuple) -> None:
    await session.execute(
        update(GitHubIssuedToken)
        .where(GitHubIssuedToken.tenant_id == require_tenant_id(), *conditions)
        .values(revoke_requested=True)
    )


async def revoke_pending(
    session: AsyncSession, config: SwitchConfig, conditions: tuple
) -> bool:
    assert not session.in_transaction()
    try:
        return await _revoke_pending(session, config, conditions)
    except Exception as error:
        logger.error(
            "Committed access change has pending GitHub cleanup: error_type=%s",
            type(error).__name__,
        )
        try:
            await session.rollback()
        except Exception as rollback_error:
            logger.error(
                "GitHub cleanup rollback failed: error_type=%s",
                type(rollback_error).__name__,
            )
        return True


async def _revoke_pending(
    session: AsyncSession, config: SwitchConfig, conditions: tuple
) -> bool:
    """Run one bounded batch after the caller has committed its access change."""
    assert not session.in_transaction()
    tenant_id = require_tenant_id()
    await session.execute(text("SET LOCAL lock_timeout = '2s'"))
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"github-revocation:{tenant_id}"},
    )
    await session.execute(
        delete(GitHubIssuedToken).where(
            GitHubIssuedToken.tenant_id == tenant_id,
            GitHubIssuedToken.expires_at <= datetime.now(UTC),
        )
    )
    valid_launch = exists(
        select(HostedLaunch.id).where(
            HostedLaunch.tenant_id == tenant_id,
            HostedLaunch.id == GitHubIssuedToken.launch_id,
            HostedLaunch.revision == GitHubIssuedToken.launch_revision,
            HostedLaunch.desired_state == "running",
            HostedLaunch.state != "error",
        )
    )
    member = exists(
        select(TenantMember.user_id).where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id == GitHubIssuedToken.owner_id,
        )
    )
    connected = exists(
        select(ProviderConnection.user_id).where(
            ProviderConnection.tenant_id == tenant_id,
            ProviderConnection.user_id == GitHubIssuedToken.owner_id,
            ProviderConnection.provider == "github",
        )
    )
    await queue_revocation(session, (~(valid_launch & member & connected),))
    deadline = datetime.now(UTC) + timedelta(seconds=90)
    rows = list(
        await session.scalars(
            select(GitHubIssuedToken)
            .where(
                GitHubIssuedToken.tenant_id == tenant_id,
                GitHubIssuedToken.revoke_requested.is_(True),
                (
                    GitHubIssuedToken.claim_until.is_(None)
                    | (GitHubIssuedToken.claim_until <= datetime.now(UTC))
                ),
                *conditions,
            )
            .order_by(GitHubIssuedToken.attempts, GitHubIssuedToken.expires_at)
            .limit(8)
        )
    )
    for row in rows:
        row.attempts += 1
        row.claim_until = deadline
    await session.commit()

    async def revoke(row: GitHubIssuedToken) -> str | None:
        try:
            async with asyncio.timeout(8):
                await GitHubInstallationCredentials.revoke(
                    decrypt_token(row.encrypted_token, config.jwt_secret_key)
                )
            return row.id
        except Exception as error:
            logger.error(
                "GitHub repository token revocation failed: tenant=%s launch=%s token_record=%s error_type=%s",
                tenant_id,
                row.launch_id,
                row.id,
                type(error).__name__,
            )
            return None

    claimed_ids = [row.id for row in rows]
    completed = [
        key for key in await asyncio.gather(*(revoke(row) for row in rows)) if key
    ]
    if completed:
        await session.execute(
            delete(GitHubIssuedToken).where(
                GitHubIssuedToken.tenant_id == tenant_id,
                GitHubIssuedToken.id.in_(completed),
                GitHubIssuedToken.claim_until == deadline,
            )
        )
    if claimed_ids:
        await session.execute(
            update(GitHubIssuedToken)
            .where(
                GitHubIssuedToken.tenant_id == tenant_id,
                GitHubIssuedToken.id.in_(claimed_ids),
                GitHubIssuedToken.claim_until == deadline,
            )
            .values(claim_until=None)
        )
    remaining = await session.scalar(
        select(GitHubIssuedToken.id)
        .where(
            GitHubIssuedToken.tenant_id == tenant_id,
            GitHubIssuedToken.revoke_requested.is_(True),
            *conditions,
        )
        .limit(1)
    )
    await session.commit()
    return remaining is not None


async def revoke_oauth(github: GitHubConnections, token: str) -> str | None:
    try:
        async with asyncio.timeout(8):
            await github.revoke(token)
    except Exception as error:
        logger.error(
            "GitHub user token revocation failed: error_type=%s", type(error).__name__
        )
        return "GitHub could not revoke the old sign-in. Revoke it in your GitHub settings."
    return None
