from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives import serialization

from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.outbound import (
    GuardedAsyncClient,
    OutboundPolicy,
    guarded_async_client,
)

logger = logging.getLogger(__name__)

DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
# Keys Google issued before it moved the endpoint still name this one, which it
# serves too.
LEGACY_TOKEN_URI = "https://accounts.google.com/o/oauth2/token"
ALLOWED_TOKEN_URIS = (DEFAULT_TOKEN_URI, LEGACY_TOKEN_URI)
DEFAULT_SERVICE_ACCOUNT_SCOPES = (
    "https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/pubsub"
)
WORKSPACE_EVENTS_SCOPES = (
    "https://www.googleapis.com/auth/chat.messages.readonly "
    "https://www.googleapis.com/auth/chat.spaces.readonly "
    "https://www.googleapis.com/auth/chat.memberships.readonly"
)


_TOKEN_REQUEST_TIMEOUT_SECONDS = 30.0
_OAUTH_ERROR_CODE_RE = re.compile(r"^[a-z_]{1,64}$")


# A service account's JSON names its own token endpoint, and the uploaded
# file is the tenant's to write. Google issues every key with one of these, so
# any other value is refused rather than POSTed a signed assertion.
def validate_token_uri(token_uri: str) -> None:
    """Refuse any token endpoint but Google's own."""
    if token_uri not in ALLOWED_TOKEN_URIS:
        raise BridgeCredentialError(
            f"Service account token_uri must be {DEFAULT_TOKEN_URI}."
        )


def _token_http_client() -> GuardedAsyncClient:
    # The token endpoint is a fixed public host, so no operator-listed private
    # address is ever needed: an empty policy allows public addresses only.
    return guarded_async_client(
        OutboundPolicy.parse(""), timeout=_TOKEN_REQUEST_TIMEOUT_SECONDS
    )


def _oauth_rejection(resp: httpx.Response, what: str) -> BridgeCredentialError:
    """The error for a refused token request, naming Google's error code but
    never echoing the response body."""
    code: str | None = None
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        raw = body.get("error")
        if isinstance(raw, str) and _OAUTH_ERROR_CODE_RE.match(raw):
            code = raw
    suffix = f": {code}" if code else ""
    return BridgeCredentialError(
        f"Google OAuth rejected {what} (status {resp.status_code}){suffix}"
    )


class GoogleAuthManager:
    """Manages Google OAuth2 tokens for Service Account and optional User OAuth."""

    def __init__(
        self,
        service_account_info: dict[str, Any],
        *,
        user_client_id: str | None = None,
        user_client_secret: str | None = None,
        user_refresh_token: str | None = None,
        scopes: str = DEFAULT_SERVICE_ACCOUNT_SCOPES,
        http_client: GuardedAsyncClient | None = None,
    ) -> None:
        self._sa_info = service_account_info
        self._user_client_id = user_client_id
        self._user_client_secret = user_client_secret
        self._user_refresh_token = user_refresh_token
        self._scopes = scopes
        self._http_client = http_client

        self._client_email: str = str(service_account_info.get("client_email") or "")
        self._private_key_raw: str = str(service_account_info.get("private_key") or "")
        self._private_key_id: str | None = service_account_info.get("private_key_id")
        self._token_uri: str = str(
            service_account_info.get("token_uri") or DEFAULT_TOKEN_URI
        )

        self._sa_token: str | None = None
        self._sa_token_expiry: float = 0.0
        self._user_token: str | None = None
        self._user_token_expiry: float = 0.0
        self._lock = asyncio.Lock()

    @property
    def client_email(self) -> str:
        return self._client_email

    @property
    def has_user_oauth(self) -> bool:
        return bool(
            self._user_client_id
            and self._user_client_secret
            and self._user_refresh_token
        )

    def validate_service_account_structure(self) -> None:
        """Validate service account dictionary has required fields and parsable private key."""
        if not self._client_email:
            raise BridgeCredentialError(
                "Service account JSON is missing required 'client_email' field."
            )
        if not self._private_key_raw:
            raise BridgeCredentialError(
                "Service account JSON is missing required 'private_key' field."
            )
        try:
            serialization.load_pem_private_key(
                self._private_key_raw.encode("utf-8"),
                password=None,
            )
        except Exception as exc:
            raise BridgeCredentialError(
                f"Failed to load service account private key: {exc}"
            ) from exc
        validate_token_uri(self._token_uri)

    def _mint_jwt_assertion(self) -> str:
        now = int(time.time())
        headers: dict[str, Any] = {"alg": "RS256", "typ": "JWT"}
        if self._private_key_id:
            headers["kid"] = self._private_key_id

        claims = {
            "iss": self._client_email,
            "sub": self._client_email,
            "aud": self._token_uri,
            "iat": now,
            "exp": now + 3600,
            "scope": self._scopes,
        }
        try:
            return jwt.encode(
                claims,
                self._private_key_raw,
                algorithm="RS256",
                headers=headers,
            )
        except Exception as exc:
            raise BridgeCredentialError(
                f"Failed to sign service account JWT assertion: {exc}"
            ) from exc

    async def get_service_account_token(self, *, force_refresh: bool = False) -> str:
        """Return a valid OAuth2 access token for the service account."""
        now = time.time()
        if not force_refresh and self._sa_token and self._sa_token_expiry > now + 300:
            return self._sa_token

        async with self._lock:
            now = time.time()
            if (
                not force_refresh
                and self._sa_token
                and self._sa_token_expiry > now + 300
            ):
                assert self._sa_token is not None
                return self._sa_token

            self.validate_service_account_structure()
            assertion = self._mint_jwt_assertion()

            data = {
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            }

            close_client = False
            client = self._http_client
            if client is None:
                client = _token_http_client()
                close_client = True

            try:
                resp = await client.post(self._token_uri, data=data)
            except Exception as exc:
                raise BridgeCredentialError(
                    f"Failed to connect to Google OAuth endpoint ({type(exc).__name__})."
                ) from exc
            finally:
                if close_client:
                    await client.aclose()

            if resp.status_code != 200:
                raise _oauth_rejection(resp, "service account assertion")

            token_data = resp.json()
            access_token = token_data.get("access_token")
            expires_in = token_data.get("expires_in", 3600)
            if not access_token:
                raise BridgeCredentialError(
                    "Google OAuth response did not contain 'access_token'."
                )

            self._sa_token = str(access_token)
            self._sa_token_expiry = now + float(expires_in)
            return self._sa_token

    async def get_user_token(self, *, force_refresh: bool = False) -> str | None:
        """Return a valid OAuth2 access token for the configured User OAuth credentials, if any."""
        if not self.has_user_oauth:
            return None

        now = time.time()
        if (
            not force_refresh
            and self._user_token
            and self._user_token_expiry > now + 300
        ):
            return self._user_token

        async with self._lock:
            now = time.time()
            if (
                not force_refresh
                and self._user_token
                and self._user_token_expiry > now + 300
            ):
                return self._user_token

            data = {
                "client_id": self._user_client_id,
                "client_secret": self._user_client_secret,
                "refresh_token": self._user_refresh_token,
                "grant_type": "refresh_token",
            }

            close_client = False
            client = self._http_client
            if client is None:
                client = _token_http_client()
                close_client = True

            try:
                resp = await client.post(DEFAULT_TOKEN_URI, data=data)
            except Exception as exc:
                raise BridgeCredentialError(
                    f"Failed to connect to Google OAuth endpoint for User OAuth refresh ({type(exc).__name__})."
                ) from exc
            finally:
                if close_client:
                    await client.aclose()

            if resp.status_code != 200:
                raise _oauth_rejection(resp, "User OAuth refresh token")

            token_data = resp.json()
            access_token = token_data.get("access_token")
            expires_in = token_data.get("expires_in", 3600)
            if not access_token:
                raise BridgeCredentialError(
                    "Google OAuth response for user refresh did not contain 'access_token'."
                )

            self._user_token = str(access_token)
            self._user_token_expiry = now + float(expires_in)
            return self._user_token
