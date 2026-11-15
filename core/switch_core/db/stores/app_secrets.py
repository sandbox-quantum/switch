"""The secrets of an app registered at a connector's vendor, as a row stores
them: one keyring-encrypted JSON object holding every secret the app's kind
has. Shared by the server's apps (`service_app_credential_store.py`) and
organizations' (`organization_app_credential_store.py`).
"""

from __future__ import annotations

import json

from switch_core.keys import Keyring


class MissingSecretsError(ValueError):
    """A save would leave the service without every secret its kind has."""

    def __init__(self, names: list[str]) -> None:
        super().__init__(f"Missing: {', '.join(names)}.")
        self.names = names


def decrypt_app_secrets(
    keyring: Keyring, encrypted: str, service: str
) -> dict[str, str]:
    """An app row's secrets. Raises `UndecryptableError` when no key opens them."""
    values = json.loads(keyring.decrypt(encrypted))
    if not isinstance(values, dict) or not all(
        isinstance(value, str) for value in values.values()
    ):
        raise ValueError(f"The stored secrets for {service} are malformed.")
    return values


def encrypt_merged_secrets(
    keyring: Keyring,
    *,
    service: str,
    stored: str | None,
    secrets: dict[str, str],
    secret_names: frozenset[str],
) -> str:
    """`secrets` merged over those `stored`, encrypted for the row.

    `secret_names` are every secret the service's kind has. A save naming
    them all replaces what is stored without reading it, so one under a key
    since retired can be entered again; any other save must find the rest
    stored, or raises `MissingSecretsError`.
    """
    if set(secrets) - secret_names:
        raise ValueError(
            f"{service} has no secret named {sorted(set(secrets) - secret_names)}."
        )
    kept = (
        {}
        if stored is None or secret_names <= set(secrets)
        else decrypt_app_secrets(keyring, stored, service)
    )
    merged = {
        name: value
        for name, value in {**kept, **secrets}.items()
        if name in secret_names
    }
    missing = secret_names - set(merged)
    if missing:
        raise MissingSecretsError(sorted(missing))
    return keyring.encrypt(json.dumps(merged))
