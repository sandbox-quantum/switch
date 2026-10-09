"""Provider logins sealed to a controller's own key.

A controller makes an X25519 keypair when it enrolls and gives Switch only the
public half (`AgentController.public_key`). The owner's client seals a login
to that key before sending it, so Switch stores and relays ciphertext it
cannot open, and only the controller holding the private key can:

- an ephemeral X25519 keypair; the shared secret with the controller's key;
- `HKDF-SHA256(shared, salt = ephemeral public key || controller public key,
  info = "switch provider login v1")` gives a 32-byte key;
- `AES-256-GCM(key, nonce, plaintext, aad)` with a random 12-byte nonce and
  `aad = "switch-provider-login-v1\\n<controller id>\\n<provider>"`, so a
  sealed login opens only for the controller and provider it was sealed for;
- the plaintext is `{"kind": ..., "credential": ...}`.

Switch checks the envelope's shape and that it names the controller's current
key (`key_id`, the first 16 hex digits of the key's SHA-256); it never sees
inside. The same construction is in `@switch-console/agent-providers`
(`sealed-login.ts`), which seals in Console and opens in the controller.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

PUBLIC_KEY_ALG = "X25519"
SEALED_LOGIN_ALG = "X25519-HKDF-SHA256-A256GCM"
# A provider auth file is at most 16 KiB; sealing adds the
# JSON around it and the tag.
MAX_CIPHERTEXT_BYTES = 20 * 1024


def _decoded(value: str, what: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"{what} must be base64") from error


def key_id(public_key: str) -> str:
    """The id a sealed login names its controller's key by."""
    return hashlib.sha256(_decoded(public_key, "key")).hexdigest()[:16]


class PublicKey(BaseModel):
    """The key a controller's provider logins are sealed to."""

    model_config = ConfigDict(extra="forbid")

    alg: Literal["X25519"]
    key: str

    @field_validator("key")
    @classmethod
    def _is_a_key(cls, value: str) -> str:
        if len(_decoded(value, "key")) != 32:
            raise ValueError("an X25519 public key is 32 bytes")
        return value


class SealedLogin(BaseModel):
    """A provider login as the owner's client sealed it."""

    model_config = ConfigDict(extra="forbid")

    alg: Literal["X25519-HKDF-SHA256-A256GCM"]
    key_id: str
    ephemeral_key: str
    nonce: str
    ciphertext: str

    @field_validator("ephemeral_key")
    @classmethod
    def _is_a_key(cls, value: str) -> str:
        if len(_decoded(value, "ephemeral_key")) != 32:
            raise ValueError("an X25519 public key is 32 bytes")
        return value

    @field_validator("nonce")
    @classmethod
    def _is_a_nonce(cls, value: str) -> str:
        if len(_decoded(value, "nonce")) != 12:
            raise ValueError("the nonce is 12 bytes")
        return value

    @field_validator("ciphertext")
    @classmethod
    def _fits(cls, value: str) -> str:
        size = len(_decoded(value, "ciphertext"))
        if size <= 16 or size > MAX_CIPHERTEXT_BYTES:
            raise ValueError(
                f"the ciphertext must be more than its tag and at most "
                f"{MAX_CIPHERTEXT_BYTES} bytes"
            )
        return value


class PutSealedLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sealed: SealedLogin
