"""Controller credentials, enrollment codes and access tokens.

Three secrets, each recognisable by its prefix so a leaked one can be told
apart from the others (and from an agent API key) at a glance:

- `swcc_…` the controller credential. Long-lived, revocable, stored as a
  sha256 hash in an `api_keys` row of type `controller`.
- `swce_…` an enrollment code. Single use, ten minutes, stored the same way
  as type `controller_enrollment`.
- `swct_…` an access token: an HS256 JWT signed with
  `CONTROLLER_TOKEN_SECRET`, audience `switch-controller`, valid for an hour.
  It is never stored; every request verifies it and then checks the
  controller has not been revoked. Its `kid` claim names the credential it
  was exchanged for, so replacing that credential retires every token
  exchanged for the old one, unexpired or not.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

import jwt

CREDENTIAL_PREFIX = "swcc_"
ENROLLMENT_CODE_PREFIX = "swce_"
ACCESS_TOKEN_PREFIX = "swct_"

ACCESS_TOKEN_AUDIENCE = "switch-controller"
ACCESS_TOKEN_ALGORITHM = "HS256"
ACCESS_TOKEN_LIFETIME = timedelta(hours=1)
ENROLLMENT_CODE_LIFETIME = timedelta(minutes=10)

_REQUIRED_CLAIMS = ["cid", "tid", "oid", "iat", "exp", "aud"]


class AccessTokenExpired(Exception):
    pass


class AccessTokenInvalid(Exception):
    pass


@dataclass(frozen=True)
class AccessTokenClaims:
    controller_id: str
    tenant_id: str
    owner_id: str
    # The `api_keys` row of the credential the token was exchanged for. None
    # on a token minted before the claim existed, which the authenticator
    # sends back to exchange again.
    credential_id: str | None


def new_credential() -> str:
    return CREDENTIAL_PREFIX + secrets.token_urlsafe(32)


def new_enrollment_code() -> str:
    return ENROLLMENT_CODE_PREFIX + secrets.token_urlsafe(18)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def mint_access_token(
    *,
    secret: str,
    controller_id: str,
    tenant_id: str,
    owner_id: str,
    credential_id: str,
    now: datetime,
) -> tuple[str, datetime]:
    """Return the access token and when it expires."""
    expires_at = now + ACCESS_TOKEN_LIFETIME
    encoded = jwt.encode(
        {
            "cid": controller_id,
            "tid": tenant_id,
            "oid": owner_id,
            "kid": credential_id,
            "aud": ACCESS_TOKEN_AUDIENCE,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        },
        secret,
        algorithm=ACCESS_TOKEN_ALGORITHM,
    )
    return ACCESS_TOKEN_PREFIX + encoded, expires_at


def verify_access_token(token: str, *, secret: str) -> AccessTokenClaims:
    """Verify signature, audience and expiry, and return the claims.

    Raises:
        AccessTokenExpired: the token was valid but its `exp` has passed.
        AccessTokenInvalid: anything else — not a controller access token, a
            bad signature, the wrong audience, or a missing claim.
    """
    if not token.startswith(ACCESS_TOKEN_PREFIX):
        raise AccessTokenInvalid("not a controller access token")
    try:
        claims = jwt.decode(
            token[len(ACCESS_TOKEN_PREFIX) :],
            secret,
            algorithms=[ACCESS_TOKEN_ALGORITHM],
            audience=ACCESS_TOKEN_AUDIENCE,
            options={"require": _REQUIRED_CLAIMS},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AccessTokenExpired("access token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AccessTokenInvalid(str(exc)) from exc
    values = (claims.get("cid"), claims.get("tid"), claims.get("oid"))
    if not all(isinstance(value, str) and value for value in values):
        raise AccessTokenInvalid("access token claims are malformed")
    credential_id = claims.get("kid")
    if credential_id is not None and not (
        isinstance(credential_id, str) and credential_id
    ):
        raise AccessTokenInvalid("access token claims are malformed")
    return AccessTokenClaims(
        controller_id=claims["cid"],
        tenant_id=claims["tid"],
        owner_id=claims["oid"],
        credential_id=credential_id,
    )
