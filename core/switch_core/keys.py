"""The server's secret keys, and the per-purpose keys derived from them.

`SECRET_KEYS` holds one or more master keys, each with an id:
``"<id>:<secret>,<id>:<secret>"``. The first is current: everything new is
encrypted and signed with it. The rest are kept so what they encrypted or
signed still opens, until boot has re-encrypted the stored values and the
signed material has expired; then they can be removed. `docs/old/key-rotation.md`
is the runbook.

Nothing uses a master key directly. Each purpose gets its own key, derived
with HKDF under a label naming the purpose, so a key that leaks from one use
(a session-signing key, say) does not open another (stored credentials).

Encrypted values carry the id of the key that encrypted them, so a keyring
with several keys knows which one to use and can tell which values still need
re-encrypting.

`JWT_SECRET_KEY`, the single secret this replaces, is legacy: when set, it
still opens values and verifies signatures made before `SECRET_KEYS` existed,
exactly as they were made. Boot re-encrypts the stored values under the
current key; removing `JWT_SECRET_KEY` afterwards ends whatever it signed.
"""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass
from enum import StrEnum

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_KEY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
MIN_SECRET_LENGTH = 32

# `<prefix><key id>$<fernet token>`. A Fernet token is URL-safe base64, so it
# never contains `$`, and a legacy value (a bare token) never starts with this.
_ENCRYPTED_PREFIX = "k1$"


class Purpose(StrEnum):
    SESSION = "gateway-session-jwt"
    OIDC_LOGIN_COOKIE = "gateway-oidc-login-cookie"
    AT_REST = "at-rest-encryption"
    INSTALL_STATE = "messaging-install-state"
    INSTALL_CONFIRM = "messaging-install-confirm"
    BRIDGE_CALLBACK = "collaboration-callback"
    TEAMS_CLIENT_STATE = "teams-graph-client-state"


class KeyringError(ValueError):
    """`SECRET_KEYS` is malformed, or a value names a key the keyring lacks."""


class UndecryptableError(ValueError):
    """A stored value no key in the keyring opens."""


@dataclass(frozen=True)
class MasterKey:
    id: str
    secret: bytes


def _hkdf(secret: bytes, purpose: Purpose) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=f"switch:{purpose.value}".encode(),
    ).derive(secret)


@dataclass(frozen=True)
class Keyring:
    keys: tuple[MasterKey, ...]
    legacy_secret: str | None

    @classmethod
    def parse(cls, value: str, *, legacy_secret: str | None) -> Keyring:
        keys: list[MasterKey] = []
        for raw in value.split(","):
            entry = raw.strip()
            if not entry:
                continue
            key_id, sep, secret = entry.partition(":")
            if not sep:
                raise KeyringError(
                    "SECRET_KEYS entries are <id>:<secret>; one has no ':'."
                )
            if not _KEY_ID_RE.match(key_id):
                raise KeyringError(
                    f"SECRET_KEYS key id {key_id!r} must be 1-32 letters, "
                    "digits, '-' or '_'."
                )
            if len(secret) < MIN_SECRET_LENGTH:
                raise KeyringError(
                    f"SECRET_KEYS key {key_id!r} is shorter than "
                    f"{MIN_SECRET_LENGTH} characters."
                )
            if any(k.id == key_id for k in keys):
                raise KeyringError(f"SECRET_KEYS names key {key_id!r} twice.")
            keys.append(MasterKey(id=key_id, secret=secret.encode()))
        if not keys:
            raise KeyringError("SECRET_KEYS must name at least one key.")
        return cls(keys=tuple(keys), legacy_secret=legacy_secret or None)

    @property
    def current(self) -> MasterKey:
        return self.keys[0]

    def _key(self, key_id: str) -> MasterKey:
        for key in self.keys:
            if key.id == key_id:
                return key
        raise KeyringError(f"No key {key_id!r} in SECRET_KEYS.")

    def derive(self, purpose: Purpose, key_id: str | None = None) -> bytes:
        """The key for `purpose` under master key `key_id` (default: current)."""
        key = self.current if key_id is None else self._key(key_id)
        return _hkdf(key.secret, purpose)

    def verification_keys(self, purpose: Purpose) -> list[bytes]:
        """Every key a signature for `purpose` may have been made with: each
        master key's, current first. Legacy material is the caller's to add,
        because how the old secret signed differs by purpose."""
        return [_hkdf(key.secret, purpose) for key in self.keys]

    # ── Encryption at rest ──────────────────────────────────────────────────

    def _fernet(self, key_id: str) -> Fernet:
        return Fernet(base64.urlsafe_b64encode(self.derive(Purpose.AT_REST, key_id)))

    def encrypt(self, plaintext: str) -> str:
        token = self._fernet(self.current.id).encrypt(plaintext.encode()).decode()
        return f"{_ENCRYPTED_PREFIX}{self.current.id}${token}"

    def decrypt(self, value: str) -> str:
        if value.startswith(_ENCRYPTED_PREFIX):
            key_id, sep, token = value[len(_ENCRYPTED_PREFIX) :].partition("$")
            if not sep:
                raise UndecryptableError("Encrypted value is malformed.")
            try:
                fernet = self._fernet(key_id)
            except KeyringError as exc:
                raise UndecryptableError(
                    f"Value was encrypted with key {key_id!r}, which is no "
                    "longer in SECRET_KEYS."
                ) from exc
            try:
                return fernet.decrypt(token.encode()).decode()
            except InvalidToken as exc:
                raise UndecryptableError(
                    f"Key {key_id!r} in SECRET_KEYS does not open this value; "
                    "its secret has changed since it was written."
                ) from exc
        if self.legacy_secret is None:
            raise UndecryptableError(
                "Value predates SECRET_KEYS and JWT_SECRET_KEY is not set to open it."
            )
        legacy = Fernet(
            base64.urlsafe_b64encode(
                hashlib.sha256(self.legacy_secret.encode()).digest()
            )
        )
        try:
            return legacy.decrypt(value.encode()).decode()
        except InvalidToken as exc:
            raise UndecryptableError(
                "JWT_SECRET_KEY does not open this value."
            ) from exc

    def is_current(self, value: str) -> bool:
        """Whether `value` is encrypted with the current key."""
        return value.startswith(f"{_ENCRYPTED_PREFIX}{self.current.id}$")

    def current_prefix(self) -> str:
        """What every value encrypted with the current key starts with."""
        return f"{_ENCRYPTED_PREFIX}{self.current.id}$"
