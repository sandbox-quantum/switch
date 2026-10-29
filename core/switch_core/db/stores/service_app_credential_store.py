"""The apps the operator registered at connectors' vendors, one per service.

A global table (`rls_ddl.GLOBAL_TABLES`): read and written in whatever
session the caller holds, bound to a tenant or not. The secrets are one
keyring-encrypted JSON object per row; a save that names only some of them
keeps the rest.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ServiceAppCredential
from switch_core.db.stores.app_secrets import (
    decrypt_app_secrets,
    encrypt_merged_secrets,
)
from switch_core.keys import Keyring


class ServiceAppCredentialStore:
    def __init__(self, keyring: Keyring) -> None:
        self._keyring = keyring

    async def get(
        self, session: AsyncSession, service: str
    ) -> ServiceAppCredential | None:
        result = await session.execute(
            select(ServiceAppCredential)
            .where(ServiceAppCredential.service == service)
            .execution_options(populate_existing=True)
        )
        return result.scalar_one_or_none()

    async def list_all(self, session: AsyncSession) -> dict[str, ServiceAppCredential]:
        return {
            row.service: row
            for row in await session.scalars(
                select(ServiceAppCredential).execution_options(populate_existing=True)
            )
        }

    def secrets(self, row: ServiceAppCredential) -> dict[str, str]:
        """The row's secrets. Raises `UndecryptableError` when no key opens them."""
        return decrypt_app_secrets(self._keyring, row.encrypted_secrets, row.service)

    async def save(
        self,
        session: AsyncSession,
        *,
        service: str,
        client_id: str,
        settings: dict[str, Any],
        secrets: dict[str, str],
        secret_names: frozenset[str],
        updated_by: str,
    ) -> ServiceAppCredential:
        """Write the row, merging `secrets` over those already stored
        (`encrypt_merged_secrets`).

        Saves of one service are serialised by a lock held to the end of the
        caller's transaction, so two operators saving different secrets at
        once both land, and a first save racing another cannot insert twice.
        """
        await _lock(session, service)
        row = await self.get(session, service)
        encrypted = encrypt_merged_secrets(
            self._keyring,
            service=service,
            stored=None if row is None else row.encrypted_secrets,
            secrets=secrets,
            secret_names=secret_names,
        )
        if row is None:
            row = ServiceAppCredential(
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

    async def record_settings(
        self,
        session: AsyncSession,
        *,
        service: str,
        client_id: str,
        settings: dict[str, Any],
        updated_by: str,
    ) -> ServiceAppCredential | None:
        """Store `settings` as the vendor answered them again for the app
        saved with `client_id`, its secrets untouched. None, with nothing
        written, where that app is no longer the one saved. Holds the lock a
        save does."""
        await _lock(session, service)
        row = await self.get(session, service)
        if row is None or row.client_id != client_id:
            return None
        row.settings = dict(settings)
        row.updated_by = updated_by
        await session.flush()
        await session.refresh(row)
        return row

    async def remove(
        self, session: AsyncSession, service: str
    ) -> ServiceAppCredential | None:
        """Delete the row; the one removed, or None when there was none."""
        row = await self.get(session, service)
        if row is not None:
            await session.execute(
                delete(ServiceAppCredential).where(
                    ServiceAppCredential.service == service
                )
            )
            await session.flush()
        return row


async def _lock(session: AsyncSession, service: str) -> None:
    """Serialise changes to `service`'s row to the end of the transaction."""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"service-app-credential:{service}"},
    )
