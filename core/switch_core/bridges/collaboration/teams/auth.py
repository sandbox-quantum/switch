from __future__ import annotations

import logging
import time

import httpx
import jwt
from jwt import PyJWKClient

logger = logging.getLogger(__name__)

# Scope for the Bot Connector service (outbound activities via serviceUrl).
BOT_CONNECTOR_SCOPE = "https://api.botframework.com/.default"
# Scope for Microsoft Graph (channel-message capture + provisioning).
GRAPH_SCOPE = "https://graph.microsoft.com/.default"

# OpenID metadata for tokens the Bot Connector attaches to inbound activities.
_BOTFRAMEWORK_OPENID = (
    "https://login.botframework.com/v1/.well-known/openidconfiguration"
)
# Expected issuer of Bot Connector tokens (public Azure cloud).
_BOTFRAMEWORK_ISSUER = "https://api.botframework.com"


class TeamsTokenProvider:
    """Acquires and caches AAD app-only (client-credentials) access tokens.

    One provider per bridge, shared by the Bot Connector (outbound) and Graph
    (capture/provisioning) call paths — each scope is cached independently with
    its own expiry. Tokens are refreshed a minute before expiry so an in-flight
    request never carries a just-expired token.
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        app_id: str,
        app_password: str,
        http: httpx.AsyncClient,
    ) -> None:
        self._token_url = (
            f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        )
        self._app_id = app_id
        self._app_password = app_password
        self._http = http
        # scope -> (access_token, expires_at_epoch)
        self._cache: dict[str, tuple[str, float]] = {}

    async def token(self, scope: str) -> str:
        cached = self._cache.get(scope)
        now = time.time()
        if cached and cached[1] - 60 > now:
            return cached[0]

        resp = await self._http.post(
            self._token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self._app_id,
                "client_secret": self._app_password,
                "scope": scope,
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"AAD token request for scope {scope} failed "
                f"({resp.status_code}): {resp.text}"
            )
        payload = resp.json()
        access_token = str(payload["access_token"])
        expires_in = float(payload.get("expires_in", 3600))
        self._cache[scope] = (access_token, now + expires_in)
        return access_token

    async def bot_token(self) -> str:
        return await self.token(BOT_CONNECTOR_SCOPE)

    async def graph_token(self) -> str:
        return await self.token(GRAPH_SCOPE)


class InboundActivityValidator:
    """Validates the JWT the Bot Connector attaches to inbound activities.

    Bot Framework signs each inbound call with a token issued by
    ``https://api.botframework.com``; the bot must verify the signature against
    the published JWKS and confirm the audience is its own app id before
    trusting the activity. This rejects forged POSTs to the messaging endpoint.
    """

    def __init__(self, *, app_id: str) -> None:
        self._app_id = app_id
        self._jwks: PyJWKClient | None = None
        self._jwks_uri: str | None = None
        self._http = httpx.Client(timeout=10)

    def _ensure_jwks(self) -> PyJWKClient:
        if self._jwks is not None:
            return self._jwks
        meta = self._http.get(_BOTFRAMEWORK_OPENID)
        meta.raise_for_status()
        self._jwks_uri = meta.json()["jwks_uri"]
        self._jwks = PyJWKClient(self._jwks_uri)
        return self._jwks

    def validate(self, auth_header: str | None) -> None:
        """Raise if the Authorization header is missing or the token is invalid."""
        if not auth_header or not auth_header.lower().startswith("bearer "):
            raise PermissionError("missing bearer token on inbound Teams activity")
        token = auth_header.split(" ", 1)[1].strip()
        signing_key = self._ensure_jwks().get_signing_key_from_jwt(token)
        jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=self._app_id,
            issuer=_BOTFRAMEWORK_ISSUER,
            options={"require": ["exp", "iss", "aud"]},
        )

    def close(self) -> None:
        self._http.close()
