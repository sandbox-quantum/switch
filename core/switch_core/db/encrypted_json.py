"""A JSONB column whose whole value is encrypted at rest.

For connection settings — a collaboration bridge's or a server connector's —
which carry platform credentials (bot tokens, app passwords, a server
password) next to ordinary settings. Encrypting the whole value rather than
named fields means a credential field an adapter adds later is covered without
anyone remembering to list it.

The stored shape is ``{"_enc": "<encrypted value>"}``, encrypted by the
server's `Keyring`; the application only ever sees the decrypted dict. A value
without that shape predates encryption: it is returned as it is, and
`reencrypt_stale_values` rewrites such rows at boot, along with any encrypted
under a key that is no longer current.

The keyring is process-wide because a column type is: SQLAlchemy builds it once
with the model, long before any configuration exists. `configure` must run
before the first read or write, and either raises if it has not.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Dialect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import attributes
from sqlalchemy.types import TypeDecorator

from switch_core.keys import Keyring

logger = logging.getLogger(__name__)

_ENVELOPE_KEY = "_enc"
_keyring: Keyring | None = None


class EncryptionNotConfiguredError(RuntimeError):
    pass


def configure(keyring: Keyring) -> None:
    """Set the keyring encrypted columns are encrypted with."""
    global _keyring
    _keyring = keyring


def _require_keyring() -> Keyring:
    if _keyring is None:
        raise EncryptionNotConfiguredError(
            "An encrypted column was read or written before "
            "switch_core.db.encrypted_json.configure() was called."
        )
    return _keyring


def is_encrypted(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {_ENVELOPE_KEY}


class EncryptedJSONB(TypeDecorator[dict[str, Any]]):
    impl = JSONB
    cache_ok = True

    def __init__(self) -> None:
        # `None` is SQL NULL, not the JSON `null` a plain JSONB column writes:
        # there is nothing to encrypt in an absent config.
        super().__init__(none_as_null=True)

    def process_bind_param(
        self, value: dict[str, Any] | None, dialect: Dialect
    ) -> dict[str, str] | None:
        if value is None:
            return None
        return {_ENVELOPE_KEY: _require_keyring().encrypt(json.dumps(value))}

    def process_result_value(
        self, value: Any, dialect: Dialect
    ) -> dict[str, Any] | None:
        if value is None:
            return None
        if is_encrypted(value):
            decrypted: dict[str, Any] = json.loads(
                _require_keyring().decrypt(value[_ENVELOPE_KEY])
            )
            return decrypted
        logger.warning(
            "Read a connection config that is not yet encrypted at rest; it "
            "will be encrypted the next time it is written or at next boot."
        )
        plain: dict[str, Any] = value
        return plain


async def reencrypt_stale_values(
    session: AsyncSession, model: type[Any], column: str
) -> int:
    """Rewrite every row of `model` whose `column` is not encrypted under the
    current key: still plaintext, or encrypted with an older or legacy key.

    Runs on the caller's session, so under whatever tenant it is bound to —
    the boot fan-out calls it once per tenant. Returns how many rows it
    rewrote; the caller commits.
    """
    stored = model.__table__.c[column]
    current = _require_keyring().current_prefix()
    rows = await session.execute(
        select(model.id).where(
            func.jsonb_typeof(stored) == "object",
            or_(
                ~func.jsonb_exists(stored, _ENVELOPE_KEY),
                ~stored[_ENVELOPE_KEY].astext.startswith(current, autoescape=True),
            ),
        )
    )
    ids = list(rows.scalars())
    if not ids:
        return 0
    instances = await session.execute(select(model).where(model.id.in_(ids)))
    for instance in instances.scalars():
        attributes.flag_modified(instance, column)
    await session.flush()
    return len(ids)
