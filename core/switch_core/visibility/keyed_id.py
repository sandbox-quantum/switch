"""Keyed ids: what operators, the audit log and Datadog see instead of raw ids.

An HMAC-SHA256 of the kind and the raw id, under one key that only Core holds
(spec rule 3). Without the key the id can't be turned back into a raw id; with
it, anyone could hash every id and match them up, so the key is a credential.

The key lives in a file only Core's own user can read. It is never taken from
an environment variable or a compose line, which show up in `docker inspect`
and process listings, and it is never logged: `KeyedIdKey` hides it in `repr`.

Each id carries the key's version as a prefix (`k1-…`), so after a rotation an
old id visibly fails to match instead of quietly matching nothing.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import stat
from enum import StrEnum
from pathlib import Path

# Stored or exported ids keep at least 12 hex characters; 16
# leaves room. The 4-character form is for display only, never for actions.
STORED_HEX = 16
DISPLAY_HEX = 4
MIN_KEY_BYTES = 32
MAX_KEY_BYTES = 4096
_VERSION = re.compile(r"^k[0-9]{1,3}$")
_KEYED = re.compile(rf"^(k[0-9]{{1,3}})-([0-9a-f]{{{STORED_HEX}}})$")


class KeyedIdKind(StrEnum):
    USER = "user"
    WORKSPACE = "workspace"
    MACHINE = "machine"
    BOX = "box"


class KeyedIdKeyError(ValueError):
    """The key file is missing, unsafe or unusable. Core does not start."""


class KeyedIdKey:
    """The key and its version. Never printed."""

    __slots__ = ("_secret", "version")

    def __init__(self, secret: bytes, version: str) -> None:
        if not _VERSION.match(version):
            raise KeyedIdKeyError(f"key version {version!r} must look like k1")
        if not MIN_KEY_BYTES <= len(secret) <= MAX_KEY_BYTES:
            raise KeyedIdKeyError(
                f"the key must be {MIN_KEY_BYTES} to {MAX_KEY_BYTES} bytes"
            )
        self._secret = secret
        self.version = version

    def __repr__(self) -> str:
        return f"KeyedIdKey(version={self.version!r}, secret=<hidden>)"

    def keyed_id(self, kind: KeyedIdKind, raw_id: str) -> str:
        """`k1-` and 16 hex characters. The kind is hashed in, so a user and a
        workspace that happen to share an id never share a keyed id."""
        if not raw_id:
            raise ValueError("raw_id is empty")
        digest = hmac.new(
            self._secret, f"{kind.value}\x00{raw_id}".encode(), hashlib.sha256
        ).hexdigest()
        return f"{self.version}-{digest[:STORED_HEX]}"


def display_form(keyed: str) -> str:
    """The short form shown on screens: the first 4 hex characters."""
    match = _KEYED.match(keyed)
    if match is None:
        raise ValueError("not a keyed id")
    return match.group(2)[:DISPLAY_HEX]


def is_keyed_id(value: str) -> bool:
    return _KEYED.match(value) is not None


def load_key(path: str | Path, version: str) -> KeyedIdKey:
    """Read the key from `path`, refusing a file anyone else could read.

    It must be a regular file (not a link), owned by this process's user, with
    no group or other permission bits (0400 or 0600). The key is the file's
    bytes, less one trailing newline (`\\n` or `\\r\\n`) an editor may add; no
    other byte is touched, so a binary key is used exactly as written.
    """
    p = Path(path)
    try:
        # O_NOFOLLOW and fstat on the open file, so the file checked is the
        # file read: nothing can swap it between the check and the read.
        fd = os.open(
            p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
        )
    except FileNotFoundError as exc:
        raise KeyedIdKeyError(f"the keyed-id key file {p} does not exist") from exc
    except OSError as exc:
        # ELOOP for a link, among others.
        raise KeyedIdKeyError(
            f"the keyed-id key file {p} can't be opened as a regular file"
        ) from exc
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise KeyedIdKeyError(f"the keyed-id key file {p} is not a regular file")
        if info.st_uid != os.getuid():
            raise KeyedIdKeyError(
                f"the keyed-id key file {p} is not owned by Core's user"
            )
        if info.st_mode & 0o077:
            raise KeyedIdKeyError(
                f"the keyed-id key file {p} can be read by others; make it 0400"
            )
        if info.st_size > MAX_KEY_BYTES + 64:
            raise KeyedIdKeyError(f"the keyed-id key file {p} is too large")
        secret = handle.read(MAX_KEY_BYTES + 65)
    if secret.endswith(b"\r\n"):
        secret = secret[:-2]
    elif secret.endswith(b"\n"):
        secret = secret[:-1]
    return KeyedIdKey(secret, version)
