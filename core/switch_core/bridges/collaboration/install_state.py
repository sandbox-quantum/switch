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

The signing key is derived from `JWT_SECRET_KEY` rather than being another
value to deploy, but it is *derived* rather than reused: a token minted here
must never be mistakable for an agent's JWT, or for whatever the next thing to
want a signature turns out to be.

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

#: Distinguishes this key from every other use of `JWT_SECRET_KEY`, and this
#: token format from whatever replaces it. Changing either string invalidates
#: every state in flight, which for a flow measured in seconds is free.
_KEY_INFO = b"switch/messaging-install-state/v1"

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


def _signing_key(secret: str) -> bytes:
    return hmac.new(secret.encode(), _KEY_INFO, hashlib.sha256).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(encoded: str) -> bytes:
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))


def mint(state: InstallState, *, secret: str) -> str:
    """Sign a state for the platform to hand back to us unchanged."""
    payload = _b64(
        json.dumps(
            {"tid": state.tenant_id, "sid": state.state_id, "plat": state.platform},
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    )
    signature = hmac.new(_signing_key(secret), payload.encode(), hashlib.sha256)
    return f"{_PREFIX}{payload}.{_b64(signature.digest())}"


def verify(token: str, *, secret: str) -> InstallState:
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

    expected = hmac.new(_signing_key(secret), payload.encode(), hashlib.sha256).digest()
    try:
        matches = hmac.compare_digest(_unb64(signature), expected)
    except ValueError:
        raise InstallStateError("install state is malformed") from None
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


def _compact_signing_key(secret: str, platform: str) -> bytes:
    return hmac.new(
        secret.encode(), _COMPACT_KEY_INFO + platform.encode(), hashlib.sha256
    ).digest()


def mint_compact(state: InstallState, *, secret: str) -> str:
    """Sign a state short enough to ride in a 64-character deep link.

    Both ids must be UUIDs, which every tenant and state row is in production.
    Anything else is a programming error rather than a state to mint, and
    raises `ValueError` instead of producing a token that could not round-trip.
    """
    body = uuid.UUID(state.tenant_id).bytes + uuid.UUID(state.state_id).bytes
    mac = hmac.new(
        _compact_signing_key(secret, state.platform), body, hashlib.sha256
    ).digest()[:_COMPACT_MAC_BYTES]
    return f"{_COMPACT_PREFIX}{_b64(body + mac)}"


def verify_compact(token: str, *, platform: str, secret: str) -> InstallState:
    """Recover a compact state minted for `platform`, or raise.

    The platform is an argument rather than a field because the token does not
    carry one: the caller says which platform it is listening as, and a token
    minted for any other fails the MAC like a forgery would.
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
    expected = hmac.new(
        _compact_signing_key(secret, platform), body, hashlib.sha256
    ).digest()[:_COMPACT_MAC_BYTES]
    if not hmac.compare_digest(mac, expected):
        raise InstallStateError("install state was not signed by this deployment")

    return InstallState(
        tenant_id=str(uuid.UUID(bytes=body[:16])),
        state_id=str(uuid.UUID(bytes=body[16:])),
        platform=platform,
    )
