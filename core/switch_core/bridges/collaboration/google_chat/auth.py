from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives import serialization

from switch_core.bridges.collaboration.models import BridgeCredentialError

logger = logging.getLogger(__name__)

DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
DEFAULT_SERVICE_ACCOUNT_SCOPES = (
    "https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/pubsub"
)
WORKSPACE_EVENTS_SCOPES = (
    "https://www.googleapis.com/auth/chat.messages.readonly "
    "https://www.googleapis.com/auth/chat.spaces.readonly "
    "https://www.googleapis.com/auth/chat.memberships.readonly"
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
        http_client: httpx.AsyncClient | None = None,
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
                client = httpx.AsyncClient(timeout=30.0)
                close_client = True

            try:
                resp = await client.post(self._token_uri, data=data)
            except Exception as exc:
                raise BridgeCredentialError(
                    f"Failed to connect to Google OAuth endpoint ({self._token_uri}): {exc}"
                ) from exc
            finally:
                if close_client:
                    await client.aclose()

            if resp.status_code != 200:
                try:
                    err_json = resp.json()
                    err_desc = (
                        err_json.get("error_description")
                        or err_json.get("error")
                        or resp.text
                    )
                except Exception:
                    err_desc = resp.text
                raise BridgeCredentialError(
                    f"Google OAuth rejected service account assertion (status {resp.status_code}): {err_desc}"
                )

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
                client = httpx.AsyncClient(timeout=30.0)
                close_client = True

            try:
                resp = await client.post(DEFAULT_TOKEN_URI, data=data)
            except Exception as exc:
                raise BridgeCredentialError(
                    f"Failed to connect to Google OAuth endpoint for User OAuth refresh: {exc}"
                ) from exc
            finally:
                if close_client:
                    await client.aclose()

            if resp.status_code != 200:
                try:
                    err_json = resp.json()
                    err_desc = (
                        err_json.get("error_description")
                        or err_json.get("error")
                        or resp.text
                    )
                except Exception:
                    err_desc = resp.text
                raise BridgeCredentialError(
                    f"Google OAuth rejected User OAuth refresh token (status {resp.status_code}): {err_desc}"
                )

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
