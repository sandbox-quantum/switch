"""The apps organizations registered at connectors' vendors, one per
organization and service.

The organization's counterpart of `ServiceAppCredentialStore`, and the same
rules for secrets: one keyring-encrypted JSON object per row, and a save that
names only some of them keeps the rest. Every method names the organization;
the table's policy (`db/rls_ddl.py`) also holds the session to the
organization it has bound, directly or through a bound workspace.
"""

from __future__ import annotations

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import OrganizationAppCredential
from switch_core.db.stores.app_secrets import (
    decrypt_app_secrets,
    encrypt_merged_secrets,
)
from switch_core.keys import Keyring


class OrganizationAppCredentialStore:
    def __init__(self, keyring: Keyring) -> None:
        self._keyring = keyring

    async def get(
        self, session: AsyncSession, organization_id: str, service: str
    ) -> OrganizationAppCredential | None:
        result = await session.execute(
            select(OrganizationAppCredential)
            .where(
                OrganizationAppCredential.organization_id == organization_id,
                OrganizationAppCredential.service == service,
            )
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def list_all(
        self, session: AsyncSession, organization_id: str
    ) -> dict[str, OrganizationAppCredential]:
        return {
            row.service: row
            for row in await session.scalars(
                select(OrganizationAppCredential)
                .where(OrganizationAppCredential.organization_id == organization_id)
                .execution_options(populate_existing=True)
            )
        }

    def secrets(self, row: OrganizationAppCredential) -> dict[str, str]:
        """The row's secrets. Raises `UndecryptableError` when no key opens them."""
        return decrypt_app_secrets(self._keyring, row.encrypted_secrets, row.service)

    async def save(
        self,
        session: AsyncSession,
        *,
        organization_id: str,
        service: str,
        client_id: str,
        settings: dict[str, str],
        secrets: dict[str, str],
        secret_names: frozenset[str],
        updated_by: str,
    ) -> OrganizationAppCredential:
        """Write the row, merging `secrets` over those already stored
        (`encrypt_merged_secrets`).

        Saves of one organization's service are serialised by a lock held to
        the end of the caller's transaction, as the server's are.
        """
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"organization-app-credential:{organization_id}:{service}"},
        )
        row = await self.get(session, organization_id, service)
        encrypted = encrypt_merged_secrets(
            self._keyring,
            service=service,
            stored=None if row is None else row.encrypted_secrets,
            secrets=secrets,
            secret_names=secret_names,
        )
        if row is None:
            row = OrganizationAppCredential(
                organization_id=organization_id,
                service=service,
                client_id=client_id,
                settings=dict(settings),
                encrypted_secrets=encrypted,
                updated_by=updated_by,
            )
            session.add(row)
        else:
            row.client_id = client_id
            row.settings = dict(settings)
            row.encrypted_secrets = encrypted
            row.updated_by = updated_by
        await session.flush()
        await session.refresh(row)
        return row

    async def remove(
        self, session: AsyncSession, organization_id: str, service: str
    ) -> OrganizationAppCredential | None:
        """Delete the row; the one removed, or None when there was none."""
        row = await self.get(session, organization_id, service)
        if row is not None:
            await session.execute(
                delete(OrganizationAppCredential).where(
                    OrganizationAppCredential.organization_id == organization_id,
                    OrganizationAppCredential.service == service,
                )
            )
            await session.flush()
        return row
