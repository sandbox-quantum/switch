"""Service connections, the grants made on them, and records of issued tokens.

This store moves ciphertext and never a plaintext: the credential broker
(`connections/broker.py`) is the only code that decrypts a connection's secret
or an issued token.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import delete, exists, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    HostedLaunch,
    ServiceConnection,
    ServiceGrant,
    ServiceTokenIssuance,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.hosted_machine_store import lock_launch


class ServiceConnectionBusy(Exception):
    pass


class ServiceConnectionChanged(Exception):
    pass


class ServiceConnectionStore:
    async def lock_connection(
        self, session: AsyncSession, user_id: str, service: str
    ) -> None:
        """Serialise every change to one connection, for this transaction.

        Refreshing a rotating secret spends the old refresh token, so two
        refreshes must never overlap; and a token is recorded under the same
        lock a disconnect takes, so the disconnect's revocation always covers
        it.
        """
        await session.execute(text("SET LOCAL lock_timeout = '25s'"))
        try:
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {
                    "key": f"service-connection:{require_tenant_id()}:{user_id}:{service}"
                },
            )
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) == "55P03":
                raise ServiceConnectionBusy(
                    "The connection is busy. Please retry."
                ) from None
            raise

    async def lock_cloud_launches(self, session: AsyncSession, agent_id: str) -> None:
        """Hold the agent's cloud launches against a lifecycle change, for this
        transaction.

        Taken before the connection lock: a lifecycle step holds its launch's
        lock while it deletes the agent, and the agent's grants with it.
        """
        launch_ids = list(
            await session.scalars(
                select(HostedLaunch.id)
                .where(
                    HostedLaunch.tenant_id == require_tenant_id(),
                    HostedLaunch.agent_id == agent_id,
                    HostedLaunch.state != "deleted",
                )
                .order_by(HostedLaunch.id)
            )
        )
        if not launch_ids:
            return
        await session.execute(text("SET LOCAL lock_timeout = '25s'"))
        try:
            for launch_id in launch_ids:
                await lock_launch(session, launch_id)
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) == "55P03":
                raise ServiceConnectionBusy(
                    "The agent's cloud launch is busy. Please retry."
                ) from None
            raise

    # ── Connections ──────────────────────────────────────────────────────────

    async def get_connection(
        self, session: AsyncSession, user_id: str, service: str
    ) -> ServiceConnection | None:
        result = await session.execute(
            select(ServiceConnection)
            .where(
                ServiceConnection.tenant_id == require_tenant_id(),
                ServiceConnection.user_id == user_id,
                ServiceConnection.service == service,
            )
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def list_connections(
        self, session: AsyncSession, user_id: str
    ) -> list[ServiceConnection]:
        return list(
            await session.scalars(
                select(ServiceConnection)
                .where(
                    ServiceConnection.tenant_id == require_tenant_id(),
                    ServiceConnection.user_id == user_id,
                )
                .order_by(ServiceConnection.service)
            )
        )

    async def save_connection(
        self,
        session: AsyncSession,
        *,
        user_id: str,
        service: str,
        consent: str,
        granted_scopes: list[str],
        account_id: str,
        external_identity: str,
        encrypted_secret: str,
    ) -> None:
        """Connect, or re-link in place: the grants on it are kept.

        A re-link to a different account changes `account_id`, which every
        grant made for the old one no longer matches.
        """
        values: dict[str, Any] = {
            "status": "active",
            "consent": consent,
            "granted_scopes": granted_scopes,
            "account_id": account_id,
            "external_identity": external_identity,
            "encrypted_secret": encrypted_secret,
            "error_code": None,
        }
        await session.execute(
            insert(ServiceConnection)
            .values(
                tenant_id=require_tenant_id(),
                user_id=user_id,
                service=service,
                secret_revision=1,
                **values,
            )
            .on_conflict_do_update(
                index_elements=["tenant_id", "user_id", "service"],
                set_={
                    **values,
                    "secret_revision": ServiceConnection.secret_revision + 1,
                    "updated_at": func.now(),
                },
            )
        )

    async def replace_secret(
        self,
        session: AsyncSession,
        user_id: str,
        service: str,
        *,
        revision: int,
        encrypted_secret: str,
    ) -> int:
        """Store a refreshed secret over the one at `revision`; the new revision."""
        updated = await session.scalar(
            update(ServiceConnection)
            .where(
                ServiceConnection.tenant_id == require_tenant_id(),
                ServiceConnection.user_id == user_id,
                ServiceConnection.service == service,
                ServiceConnection.secret_revision == revision,
            )
            .values(
                encrypted_secret=encrypted_secret,
                secret_revision=revision + 1,
                updated_at=func.now(),
            )
            .returning(ServiceConnection.secret_revision)
        )
        if updated is None:
            raise ServiceConnectionChanged(
                f"The {service} connection changed while its secret was refreshed."
            )
        return updated

    async def mark_needs_reauthorization(
        self, session: AsyncSession, user_id: str, service: str, error_code: str
    ) -> None:
        await session.execute(
            update(ServiceConnection)
            .where(
                ServiceConnection.tenant_id == require_tenant_id(),
                ServiceConnection.user_id == user_id,
                ServiceConnection.service == service,
            )
            .values(
                status="needs_reauthorization",
                error_code=error_code,
                updated_at=func.now(),
            )
        )

    async def delete_connection(
        self, session: AsyncSession, user_id: str, service: str
    ) -> None:
        """Delete it; its grants go with it, by their foreign key."""
        await session.execute(
            delete(ServiceConnection).where(
                ServiceConnection.tenant_id == require_tenant_id(),
                ServiceConnection.user_id == user_id,
                ServiceConnection.service == service,
            )
        )

    # ── Grants ───────────────────────────────────────────────────────────────

    async def get_grant(
        self, session: AsyncSession, agent_id: str, service: str
    ) -> ServiceGrant | None:
        result = await session.execute(
            select(ServiceGrant)
            .where(
                ServiceGrant.tenant_id == require_tenant_id(),
                ServiceGrant.agent_id == agent_id,
                ServiceGrant.service == service,
            )
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def get_grant_to_record(
        self, session: AsyncSession, agent_id: str, service: str
    ) -> ServiceGrant | None:
        """The grant, held against change until this transaction ends.

        For recording a token issued under it: a change made meanwhile either
        commits first, and is seen here, or waits until the record has
        committed, and then covers it.
        """
        result = await session.execute(
            select(ServiceGrant)
            .where(
                ServiceGrant.tenant_id == require_tenant_id(),
                ServiceGrant.agent_id == agent_id,
                ServiceGrant.service == service,
            )
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def bump_grant(
        self, session: AsyncSession, agent_id: str, service: str
    ) -> None:
        """Move the agent's grant on, so a token being issued under it is not
        recorded."""
        await session.execute(
            update(ServiceGrant)
            .where(
                ServiceGrant.tenant_id == require_tenant_id(),
                ServiceGrant.agent_id == agent_id,
                ServiceGrant.service == service,
            )
            .values(revision=ServiceGrant.revision + 1, updated_at=func.now())
        )

    async def list_grants(
        self, session: AsyncSession, agent_id: str
    ) -> list[ServiceGrant]:
        return list(
            await session.scalars(
                select(ServiceGrant)
                .where(
                    ServiceGrant.tenant_id == require_tenant_id(),
                    ServiceGrant.agent_id == agent_id,
                )
                .order_by(ServiceGrant.service)
            )
        )

    async def save_grant(
        self,
        session: AsyncSession,
        *,
        agent_id: str,
        owner_id: str,
        service: str,
        access: str,
        tool_mode: str,
        tools: list[str],
        resources: dict[str, Any],
        account_id: str,
        created_by: str,
    ) -> ServiceGrant:
        """Create the agent's grant for the service, or replace it in place."""
        values: dict[str, Any] = {
            "owner_id": owner_id,
            "access": access,
            "tool_mode": tool_mode,
            "tools": tools,
            "resources": resources,
            "account_id": account_id,
        }
        await session.execute(
            insert(ServiceGrant)
            .values(
                tenant_id=require_tenant_id(),
                agent_id=agent_id,
                service=service,
                created_by=created_by,
                **values,
            )
            .on_conflict_do_update(
                index_elements=["tenant_id", "agent_id", "service"],
                set_={
                    **values,
                    "revision": ServiceGrant.revision + 1,
                    "updated_at": func.now(),
                },
            )
        )
        grant = await self.get_grant(session, agent_id, service)
        if grant is None:
            raise RuntimeError(f"The {service} grant just saved could not be read.")
        return grant

    async def delete_grant(self, session: AsyncSession, grant_id: str) -> None:
        await session.execute(
            delete(ServiceGrant).where(
                ServiceGrant.tenant_id == require_tenant_id(),
                ServiceGrant.id == grant_id,
            )
        )

    # ── Issued tokens ────────────────────────────────────────────────────────

    def add_issuance(
        self, session: AsyncSession, issuance: ServiceTokenIssuance
    ) -> None:
        session.add(issuance)

    async def queue_revocation(self, session: AsyncSession, *conditions: Any) -> None:
        """Ask for every live token matching `conditions` to be revoked."""
        await session.execute(
            update(ServiceTokenIssuance)
            .where(
                ServiceTokenIssuance.tenant_id == require_tenant_id(),
                ServiceTokenIssuance.encrypted_token.is_not(None),
                *conditions,
            )
            .values(revoke_requested=True)
        )

    async def queue_orphaned(self, session: AsyncSession) -> None:
        """Queue every live token whose grant, or owner's membership, is gone.

        A missing connection needs no test of its own: deleting one deletes
        its grants. Deleting an agent does the same, so its tokens are queued
        here too.
        """
        tenant_id = require_tenant_id()
        granted = exists(
            select(ServiceGrant.id).where(
                ServiceGrant.tenant_id == tenant_id,
                ServiceGrant.id == ServiceTokenIssuance.grant_id,
            )
        )
        member = exists(
            select(TenantMember.user_id).where(
                TenantMember.tenant_id == tenant_id,
                TenantMember.user_id == ServiceTokenIssuance.owner_id,
            )
        )
        await self.queue_revocation(
            session,
            ServiceTokenIssuance.revoke_requested.is_(False),
            ~(granted & member),
        )

    async def clear_expired(self, session: AsyncSession, now: datetime) -> None:
        """Drop the ciphertext of every token past its expiry; the record stays."""
        await session.execute(
            update(ServiceTokenIssuance)
            .where(
                ServiceTokenIssuance.tenant_id == require_tenant_id(),
                ServiceTokenIssuance.encrypted_token.is_not(None),
                ServiceTokenIssuance.expires_at <= now,
            )
            .values(encrypted_token=None, claim_until=None)
        )

    async def claim_revocations(
        self,
        session: AsyncSession,
        conditions: tuple[Any, ...],
        *,
        now: datetime,
        until: datetime,
        limit: int,
    ) -> list[ServiceTokenIssuance]:
        rows = list(
            await session.scalars(
                select(ServiceTokenIssuance)
                .where(
                    ServiceTokenIssuance.tenant_id == require_tenant_id(),
                    ServiceTokenIssuance.encrypted_token.is_not(None),
                    ServiceTokenIssuance.revoke_requested.is_(True),
                    ServiceTokenIssuance.claim_until.is_(None)
                    | (ServiceTokenIssuance.claim_until <= now),
                    *conditions,
                )
                .order_by(
                    ServiceTokenIssuance.attempts, ServiceTokenIssuance.expires_at
                )
                .limit(limit)
            )
        )
        for row in rows:
            row.attempts += 1
            row.claim_until = until
        return rows

    async def finish_revocations(
        self,
        session: AsyncSession,
        *,
        claimed_ids: list[str],
        revoked_ids: list[str],
        until: datetime,
    ) -> None:
        """Release a claim; a revoked token's ciphertext goes with it."""
        tenant_id = require_tenant_id()
        if revoked_ids:
            await session.execute(
                update(ServiceTokenIssuance)
                .where(
                    ServiceTokenIssuance.tenant_id == tenant_id,
                    ServiceTokenIssuance.id.in_(revoked_ids),
                    ServiceTokenIssuance.claim_until == until,
                )
                .values(encrypted_token=None)
            )
        if claimed_ids:
            await session.execute(
                update(ServiceTokenIssuance)
                .where(
                    ServiceTokenIssuance.tenant_id == tenant_id,
                    ServiceTokenIssuance.id.in_(claimed_ids),
                    ServiceTokenIssuance.claim_until == until,
                )
                .values(claim_until=None)
            )

    async def holds_tokens(self, session: AsyncSession) -> bool:
        """Whether the bound tenant holds any token's ciphertext at all.

        Every step of a revocation pass acts only on these rows, so a tenant
        with none has nothing to clear, queue or revoke.
        """
        held = await session.scalar(
            select(ServiceTokenIssuance.id)
            .where(
                ServiceTokenIssuance.tenant_id == require_tenant_id(),
                ServiceTokenIssuance.encrypted_token.is_not(None),
            )
            .limit(1)
        )
        return held is not None

    async def revocation_pending(
        self, session: AsyncSession, conditions: tuple[Any, ...]
    ) -> bool:
        pending = await session.scalar(
            select(ServiceTokenIssuance.id)
            .where(
                ServiceTokenIssuance.tenant_id == require_tenant_id(),
                ServiceTokenIssuance.encrypted_token.is_not(None),
                ServiceTokenIssuance.revoke_requested.is_(True),
                *conditions,
            )
            .limit(1)
        )
        return pending is not None

    async def prune(self, session: AsyncSession, cutoff: datetime) -> int:
        """Delete the bound tenant's records created before `cutoff`."""
        result = await session.execute(
            delete(ServiceTokenIssuance).where(
                ServiceTokenIssuance.tenant_id == require_tenant_id(),
                ServiceTokenIssuance.created_at < cutoff,
            )
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
