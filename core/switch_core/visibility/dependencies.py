"""Request access to the keyed-id key.

The key is loaded once, when the app is built (`load_keyed_id_key`). A key file
that is named but unsafe or unreadable stops Core from starting. With no key
configured, routes that need keyed ids answer 503: they never fall back to raw
ids or names.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException
from starlette.requests import HTTPConnection

from switch_core.config import SwitchConfig
from switch_core.visibility.keyed_id import KeyedIdKey, load_key

logger = logging.getLogger(__name__)


def load_keyed_id_key(config: SwitchConfig) -> KeyedIdKey | None:
    """The configured key, or None with one warning when none is set.
    Raises `KeyedIdKeyError` for a file that is named but can't be used."""
    if not config.visibility_keyed_id_key_path:
        logger.warning(
            "No keyed-id key is set (VISIBILITY_KEYED_ID_KEY_PATH), so the "
            "operator and admin visibility pages are unavailable"
        )
        return None
    key = load_key(
        config.visibility_keyed_id_key_path, config.visibility_keyed_id_key_version
    )
    logger.info("Keyed-id key loaded", extra={"key_version": key.version})
    return key


# The same key, for work that runs outside a request (box requests from
# sign-up and the operator's sweep). Set once when the app is built.
_process_key: dict[str, KeyedIdKey | None] = {"key": None}


def set_process_keyed_id_key(key: KeyedIdKey | None) -> None:
    _process_key["key"] = key


def process_keyed_id_key() -> KeyedIdKey | None:
    return _process_key["key"]


def get_keyed_id_key(request: HTTPConnection) -> KeyedIdKey:
    key = getattr(request.app.state, "keyed_id_key", None)
    if not isinstance(key, KeyedIdKey):
        raise HTTPException(
            status_code=503, detail="Visibility isn't set up on this server"
        )
    return key
