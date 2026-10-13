"""The `state` parameter that carries a tenant across the install round trip.

An install starts on the gateway, where the caller is authenticated and their
tenant is known, and finishes on a public callback the platform redirects the
browser to. Something has to get the tenant from one to the other, and the two
obvious candidates do not work here:

- **A cookie** is what the gateway's own OIDC flow uses, and it cannot be used
  for this. The gateway is reached on one hostname and the public callback on
  another — they are different origins by deployment, not by accident — so a
  cookie set at the start leg is simply not sent to the callback.
- **A database lookup** keyed by the state would work, but the callback runs
  with no tenant bound and RLS refuses every read until one is. Making it
  possible would mean a ninth `SECURITY DEFINER` function, and the shortness of
  that list is the property that makes it reviewable.

So the state is a token *we* sign, naming the tenant. The callback verifies the
signature, binds the tenant it names, and from that point runs as an ordinary
scoped request — every subsequent read and write is checked by RLS in the
normal way. A forged or edited state fails the signature and never reaches the
database at all.

**A signature is not enough on its own**, which is why the token names a row as
well as a tenant. A signed token stays valid as long as the key does, so a
captured state could be replayed to install an attacker's workspace against the
victim's tenant — message injection into someone else's rooms. Single use is
the missing half and only the database can provide it: the row named here is
burnt with a conditional update, and a second attempt finds nothing to burn.

The signing key is the keyring's key for this purpose (`keys.Purpose`),
derived rather than reused: a token minted here must never be mistakable for a
session JWT, or for whatever the next thing to want a signature turns out to
be. Verification accepts any key in the keyring, and while `JWT_SECRET_KEY` is
still set, a state minted with it before `SECRET_KEYS` existed.

**A second, compact form exists for platforms with no redirect.** Telegram has
no consent screen to carry a state through; the only thing that rides along
with adding its bot to a group is a deep-link start parameter of at most 64
characters from `[A-Za-z0-9_-]`, and the form above is about 150. The compact
form carries the same two ids as raw UUID bytes and a truncated MAC, and says
nothing about the platform: that is implied by the key, which is derived per
platform, so a token minted for one platform is simply unsigned to another.
Ninety-six bits of MAC is ample for a token that is also single use and dead
in ten minutes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass

from switch_core.keys import Keyring, Purpose

#: How a state was signed with `JWT_SECRET_KEY` before `SECRET_KEYS`; kept so
#: a state in flight across the upgrade still verifies.
_LEGACY_KEY_INFO = b"switch/messaging-install-state/v1"

_PREFIX = "v1."

#: The compact form's counterparts. Its key info is completed by the platform
#: name — see `_compact_signing_key`.
_COMPACT_KEY_INFO = b"switch/messaging-install-claim/c1/"
_COMPACT_PREFIX = "c1"
_COMPACT_MAC_BYTES = 12
_COMPACT_BODY_BYTES = 32


class InstallStateError(RuntimeError):
    """A state parameter was absent, malformed, or not signed by us.

    All three are the same answer to the caller — the install is refused —
    and deliberately the same answer to an observer: nothing distinguishes a
    truncated token from a forged one, because the difference is only ever
    interesting to someone probing.
    """


@dataclass(frozen=True)
class InstallState:
    """What a verified state names.

    `tenant_id` is trusted *because* the signature verified, and is bound to
    the session before anything else happens. `state_id` names the row to burn.
    `platform` is carried so the callback route's own path cannot be used to
    redeem a state minted for a different platform.
    """

    tenant_id: str
    state_id: str
    platform: str


def _verification_keys(keyring: Keyring) -> list[bytes]:
    keys = keyring.verification_keys(Purpose.INSTALL_STATE)
    if keyring.legacy_secret is not None:
        keys.append(
            hmac.new(
                keyring.legacy_secret.encode(), _LEGACY_KEY_INFO, hashlib.sha256
            ).digest()
        )
    return keys


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(encoded: str) -> bytes:
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def mint(state: InstallState, *, keyring: Keyring) -> str:
    """Sign a state for the platform to hand back to us unchanged."""
    payload = _b64(
        json.dumps(
            {"tid": state.tenant_id, "sid": state.state_id, "plat": state.platform},
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    )
    signature = hmac.new(
        keyring.derive(Purpose.INSTALL_STATE), payload.encode(), hashlib.sha256
    )
    return f"{_PREFIX}{payload}.{_b64(signature.digest())}"


def verify(token: str, *, keyring: Keyring) -> InstallState:
    """Recover the state from a token, or raise.

    Nothing here touches the database, and nothing here is trusted before the
    comparison: the payload is not decoded until its signature has matched, so
    a hostile token is bytes we compared and discarded.
    """
    if not token.startswith(_PREFIX):
        raise InstallStateError("install state is not a state this deployment minted")

    try:
        payload, signature = token[len(_PREFIX) :].split(".")
    except ValueError:
        raise InstallStateError("install state is malformed") from None

    try:
        presented = _unb64(signature)
    except ValueError:
        raise InstallStateError("install state is malformed") from None
    matches = False
    for key in _verification_keys(keyring):
        expected = hmac.new(key, payload.encode(), hashlib.sha256).digest()
        matches = hmac.compare_digest(presented, expected) or matches
    if not matches:
        raise InstallStateError("install state was not signed by this deployment")

    try:
        decoded = json.loads(_unb64(payload))
        return InstallState(
            tenant_id=decoded["tid"],
            state_id=decoded["sid"],
            platform=decoded["plat"],
        )
    except (ValueError, KeyError, TypeError):
        raise InstallStateError("install state is malformed") from None


def _compact_signing_key(key: bytes, platform: str) -> bytes:
    return hmac.new(key, _COMPACT_KEY_INFO + platform.encode(), hashlib.sha256).digest()


def _compact_mac(key: bytes, platform: str, body: bytes) -> bytes:
    return hmac.new(_compact_signing_key(key, platform), body, hashlib.sha256).digest()[
        :_COMPACT_MAC_BYTES
    ]


def mint_compact(state: InstallState, *, keyring: Keyring) -> str:
    """Sign a state short enough to ride in a 64-character deep link.

    Both ids must be UUIDs, which every tenant and state row is in production.
    Anything else is a programming error rather than a state to mint, and
    raises `ValueError` instead of producing a token that could not round-trip.
    """
    body = uuid.UUID(state.tenant_id).bytes + uuid.UUID(state.state_id).bytes
    mac = _compact_mac(keyring.derive(Purpose.INSTALL_STATE), state.platform, body)
    return f"{_COMPACT_PREFIX}{_b64(body + mac)}"


def verify_compact(token: str, *, platform: str, keyring: Keyring) -> InstallState:
    """Recover a compact state minted for `platform`, or raise.

    The platform is an argument rather than a field because the token does not
    carry one: the caller says which platform it is listening as, and a token
    minted for any other fails the MAC like a forgery would.

    Any key in the keyring verifies, as for the full form. `JWT_SECRET_KEY`
    does not: no compact state was ever minted with it.
    """
    if not token.startswith(_COMPACT_PREFIX):
        raise InstallStateError("install state is not a state this deployment minted")

    try:
        raw = _unb64(token[len(_COMPACT_PREFIX) :])
    except ValueError:
        raise InstallStateError("install state is malformed") from None
    if len(raw) != _COMPACT_BODY_BYTES + _COMPACT_MAC_BYTES:
        raise InstallStateError("install state is malformed")

    body, mac = raw[:_COMPACT_BODY_BYTES], raw[_COMPACT_BODY_BYTES:]
    matches = False
    for key in keyring.verification_keys(Purpose.INSTALL_STATE):
        expected = _compact_mac(key, platform, body)
        matches = hmac.compare_digest(mac, expected) or matches
    if not matches:
        raise InstallStateError("install state was not signed by this deployment")

    return InstallState(
        tenant_id=str(uuid.UUID(bytes=body[:16])),
        state_id=str(uuid.UUID(bytes=body[16:])),
        platform=platform,
    )
