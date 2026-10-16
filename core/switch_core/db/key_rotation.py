"""Re-encrypt stored secrets under the current key, at boot.

Every encrypted value carries the id of the key that encrypted it. After a
key is added to the front of `SECRET_KEYS`, or on the first boot after
`SECRET_KEYS` replaces `JWT_SECRET_KEY`, values under any other key are
rewritten here, so the older key can be removed once this has run.

With several processes serving at once, a new front key has to be rolled out
in two phases. First every process is given the new key at the back of
`SECRET_KEYS`, so all of them can read it while still writing under the old
one. Only then is it moved to the front: the processes that start with it
write, sign and re-encrypt under it, and the older ones still running can read
all of that. Done in one step, the first new process would rewrite every
stored secret under a key the old ones lack, and they could no longer open
bridge configs, bot tokens or API keys until replaced.
`require_front_key_readable` enforces the order: every live process records
the ids of its keys on its lease, and a process whose front key one of them
lacks refuses to start.

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
    MachineWorkspace,
    MessagingInstall,
    ProviderConnection,
    ServerConnector,
    ServiceAppCredential,
    ServiceConnection,
    ServiceOAuthClient,
    ServiceTokenIssuance,
    SignInFlow,
    TrustSettings,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.keys import Keyring
from switch_core.process_lease import read_leases

logger = logging.getLogger(__name__)

_ENCRYPTED_JSON_COLUMNS: tuple[tuple[type[Any], str], ...] = (
    (CollaborationBridge, "connection_config"),
    (ServerConnector, "connection_config"),
)
_ENCRYPTED_TEXT_COLUMNS: tuple[tuple[type[Any], str], ...] = (
    (ApiKey, "encrypted_key"),
    (MessagingInstall, "encrypted_bot_token"),
    (ProviderConnection, "encrypted_credential"),
    (MachineWorkspace, "enrollment_code_encrypted"),
    (ServiceConnection, "encrypted_secret"),
    (ServiceTokenIssuance, "encrypted_token"),
    (SignInFlow, "encrypted_verifier"),
    (SignInFlow, "encrypted_result"),
)
# In tables no tenant holds (`db/rls_ddl.py`, GLOBAL_TABLES), one row set for
# the whole deployment (`trust_settings`, `service_oauth_clients`,
# `service_app_credentials`): rewritten
# once, in a session bound to no tenant, rather than once per tenant.
_GLOBAL_ENCRYPTED_TEXT_COLUMNS: tuple[tuple[type[Any], str], ...] = (
    (TrustSettings, "api_key_encrypted"),
    (ServiceOAuthClient, "encrypted_secret"),
    (ServiceAppCredential, "encrypted_secrets"),
)


class KeyRotationError(RuntimeError):
    """A live process could not read what this one would write."""


async def require_front_key_readable(
    session_factory: async_sessionmaker[AsyncSession],
    keyring: Keyring,
    process_id: str,
) -> None:
    """Refuse to start when a live process lacks this one's front key.

    Called under the boot lock, before anything is encrypted under that key.
    A process from before keys were recorded is not checked, and is named in
    a warning instead: there is no way to know what it holds.
    """
    async with session_factory() as session:
        leases = await read_leases(session, SwitchCoreProcessStore())
    front = keyring.current.id
    lacking: list[str] = []
    unknown: list[str] = []
    for other, lease in leases.leases.items():
        if other == process_id or not leases.holds(other):
            continue
        if lease.key_ids is None:
            unknown.append(other)
        elif front not in lease.key_ids:
            lacking.append(other)
    if lacking:
        raise KeyRotationError(
            f"SECRET_KEYS puts key {front!r} first, and switch-core process(es) "
            f"{', '.join(sorted(lacking))} still running cannot read it, so what "
            "this process writes would be unreadable to them. Roll the key out "
            "in two phases: first add it at the end of SECRET_KEYS everywhere, "
            "and only once every process has it, move it to the front."
        )
    if unknown:
        logger.warning(
            "Could not check that switch-core process(es) %s can read key %r: "
            "they predate the check. If this deploy moves a new key to the "
            "front of SECRET_KEYS, they cannot read what is written under it.",
            ", ".join(sorted(unknown)),
            front,
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
        # Only while the value is still the one read: a request on another
        # process may have written a new one since, already under the
        # current key, and that is the one to keep.
        result = await session.execute(
            update(model)
            .where(
                *(
                    key == key_value
                    for key, key_value in zip(keys, key_values, strict=True)
                ),
                stored == value,
            )
            .values({column: keyring.encrypt(keyring.decrypt(value))})
        )
        count += result.rowcount  # type: ignore[attr-defined]
    return count


async def reencrypt_stored_secrets(
    session_factory: async_sessionmaker[AsyncSession],
    keyring: Keyring,
    tenant_ids: list[str],
) -> None:
    """Bring every tenant's encrypted values, plus the deployment's global
    ones, onto the current key."""
    total = 0
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            for model, column in _ENCRYPTED_JSON_COLUMNS:
                total += await reencrypt_stale_values(session, model, column)
            for model, column in _ENCRYPTED_TEXT_COLUMNS:
                total += await reencrypt_stale_text(session, keyring, model, column)
            await session.commit()
    async with session_factory() as session:
        for model, column in _GLOBAL_ENCRYPTED_TEXT_COLUMNS:
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
