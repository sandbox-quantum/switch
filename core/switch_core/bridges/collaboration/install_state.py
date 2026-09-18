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
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass

#: Distinguishes this key from every other use of `JWT_SECRET_KEY`, and this
#: token format from whatever replaces it. Changing either string invalidates
#: every state in flight, which for a flow measured in seconds is free.
_KEY_INFO = b"switch/messaging-install-state/v1"

_PREFIX = "v1."


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
