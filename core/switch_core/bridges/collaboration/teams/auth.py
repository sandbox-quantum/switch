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
        # scope -> (access_token, expires_at_epoch, issued_at_epoch)
        self._cache: dict[str, tuple[str, float, float]] = {}

    def invalidate(self, scope: str, *, min_age_seconds: float = 0.0) -> bool:
        """Drop a cached token so the next call mints a fresh one.

        An app's Graph roles are fixed when its token is issued, so a permission
        consented while the bridge is running is invisible for as long as the
        token lasts — about an hour of Graph insisting a permission is missing
        while the operator looks at it plainly granted in Azure. Throwing the
        token away on that refusal is what turns an hour into a second.

        ``min_age_seconds`` guards the pathological case: a token minted moments
        ago cannot have missed a grant, so re-minting it would only add a round
        trip to every genuine denial. Returns whether anything was dropped, so a
        caller can skip a retry that has nothing new to offer.
        """
        cached = self._cache.get(scope)
        if cached is None or time.time() - cached[2] < min_age_seconds:
            return False
        del self._cache[scope]
        return True

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
        # A 200 whose body is not the token response we expect — an HTML error
        # page from a proxy in front of AAD, or a shape change — must fail the
        # same way a 401 does. Left to raise on its own it surfaces as KeyError
        # or a JSON decode error, which callers looking for a credential problem
        # do not catch, and the save-time check turns into a 500.
        try:
            payload = resp.json()
            access_token = str(payload["access_token"])
        except (ValueError, KeyError, TypeError) as exc:
            raise RuntimeError(
                f"AAD token request for scope {scope} returned "
                f"{resp.status_code} with an unusable body: {resp.text[:500]}"
            ) from exc
        expires_in = float(payload.get("expires_in", 3600))
        self._cache[scope] = (access_token, now + expires_in, now)
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
        try:
            jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self._app_id,
                issuer=_BOTFRAMEWORK_ISSUER,
                options={"require": ["exp", "iss", "aud"]},
            )
        except jwt.InvalidAudienceError as exc:
            raise PermissionError(
                f"inbound Teams activity is addressed to {self._describe_audience(token)}, "
                f"but this bridge is configured with app id {self._app_id!r}. "
                "The Azure Bot resource's Microsoft App ID must be the app id "
                "registered on the bridge."
            ) from exc

    @staticmethod
    def _describe_audience(token: str) -> str:
        """The audience the token actually carries, for a mismatch message.

        Read without verifying — the signature has already been checked by the
        caller, and this only ever reaches a log line explaining a rejection.
        The audience of a Bot Connector token is an application id, not a
        secret; the token itself is never logged.
        """
        try:
            claims = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError:
            return "an unreadable audience"
        aud = claims.get("aud")
        return f"app id {aud!r}" if aud else "no audience"

    def close(self) -> None:
        self._http.close()
