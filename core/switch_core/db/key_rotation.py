"""Re-encrypt stored secrets under the current key, at boot.

Every encrypted value carries the id of the key that encrypted it. After a
key is added to the front of `SECRET_KEYS`, or on the first boot after
`SECRET_KEYS` replaces `JWT_SECRET_KEY`, values under any other key are
rewritten here, so the older key can be removed once this has run.

The columns are listed here rather than discovered: each is a different shape
(a JSON envelope, a bare string), and a new encrypted column is a deliberate
addition this list should be part of.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.encrypted_json import reencrypt_stale_values
from switch_core.db.models import (
    ApiKey,
    CollaborationBridge,
    GitHubIssuedToken,
    HostedLaunch,
    HostedMachine,
    MessagingInstall,
    ProviderConnection,
    ProviderVerification,
    ServerConnector,
    ServiceConnection,
    ServiceTokenIssuance,
)
from switch_core.db.session_scope import tenant_session
from switch_core.keys import Keyring

logger = logging.getLogger(__name__)

_ENCRYPTED_JSON_COLUMNS: tuple[tuple[type[Any], str], ...] = (
    (CollaborationBridge, "connection_config"),
    (ServerConnector, "connection_config"),
)
_ENCRYPTED_TEXT_COLUMNS: tuple[tuple[type[Any], str], ...] = (
    (ApiKey, "encrypted_key"),
    (MessagingInstall, "encrypted_bot_token"),
    (ProviderConnection, "encrypted_credential"),
    (ProviderVerification, "encrypted_credential"),
    (ProviderVerification, "encrypted_token"),
    (GitHubIssuedToken, "encrypted_token"),
    (HostedMachine, "machine_capability_encrypted"),
    (HostedLaunch, "worker_capability_encrypted"),
    (ServiceConnection, "encrypted_secret"),
    (ServiceTokenIssuance, "encrypted_token"),
)


async def reencrypt_stale_text(
    session: AsyncSession, keyring: Keyring, model: type[Any], column: str
) -> int:
    """Rewrite each value of a string column not under the current key.

    Raises `UndecryptableError` for a value no key opens: that is a key
    removed too early, and continuing would leave a credential nothing can
    read while reporting the rotation done.

    The empty string is skipped like NULL: a hash-only API key (a controller
    credential, an enrollment code) stores `""` because the column is NOT NULL,
    and there is nothing in it to open.
    """
    stored = model.__table__.c[column]
    # Rows are named by their primary key, which is not always a single `id`.
    keys = list(model.__table__.primary_key.columns)
    rows = await session.execute(
        select(*keys, stored).where(
            stored.is_not(None),
            stored != "",
            ~stored.startswith(keyring.current_prefix(), autoescape=True),
        )
    )
    count = 0
    for *key_values, value in rows.all():
        await session.execute(
            update(model)
            .where(
                *(
                    key == key_value
                    for key, key_value in zip(keys, key_values, strict=True)
                )
            )
            .values({column: keyring.encrypt(keyring.decrypt(value))})
        )
        count += 1
    return count


async def reencrypt_stored_secrets(
    session_factory: async_sessionmaker[AsyncSession],
    keyring: Keyring,
    tenant_ids: list[str],
) -> None:
    """Bring every tenant's encrypted values onto the current key."""
    total = 0
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            for model, column in _ENCRYPTED_JSON_COLUMNS:
                total += await reencrypt_stale_values(session, model, column)
            for model, column in _ENCRYPTED_TEXT_COLUMNS:
                total += await reencrypt_stale_text(session, keyring, model, column)
            await session.commit()
    if total:
        logger.warning(
            "Re-encrypted %d stored secret(s) under key %r. Older keys and "
            "JWT_SECRET_KEY are no longer needed to read stored values.",
            total,
            keyring.current.id,
        )
    else:
        logger.info(
            "Every stored secret is encrypted under key %r.", keyring.current.id
        )
