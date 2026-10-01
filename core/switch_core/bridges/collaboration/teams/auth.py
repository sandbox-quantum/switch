from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import serialization

logger = logging.getLogger(__name__)

# Scope for the Bot Connector service (outbound activities via serviceUrl).
BOT_CONNECTOR_SCOPE = "https://api.botframework.com/.default"
# Scope for Microsoft Graph (channel-message capture + provisioning).
GRAPH_SCOPE = "https://graph.microsoft.com/.default"

# OpenID metadata for tokens the Bot Connector attaches to inbound activities.
BOTFRAMEWORK_OPENID = (
    "https://login.botframework.com/v1/.well-known/openidconfiguration"
)
# Expected issuer of Bot Connector tokens (public Azure cloud).
BOTFRAMEWORK_ISSUER = "https://api.botframework.com"

# OpenID metadata for the Microsoft identity platform, whose keys sign the
# `validationTokens` Graph attaches to a change notification carrying data.
MICROSOFT_IDENTITY_OPENID = (
    "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"
)
# The application Graph sends change notifications as. A validation token not
# issued to it was not issued for a notification.
GRAPH_CHANGE_TRACKING_APP_ID = "0bf30f3b-4a52-48df-9a82-234910c4a086"

_JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

# Microsoft's own guidance for Bot Framework tokens: allow five minutes either
# way, since the two clocks are not ours to keep in step.
_CLOCK_SKEW_SECONDS = 300

# How long a provider's keys are trusted before being fetched again, and how
# soon an unrecognised key id may trigger a fetch of its own. The second is a
# floor so that a stream of tokens naming made-up key ids cannot turn into a
# stream of requests to Microsoft.
_KEYS_REFRESH_SECONDS = 24 * 60 * 60
_KEYS_REFETCH_FLOOR_SECONDS = 5 * 60

# Directory errors that mean the app is not approved in the directory asked.
# AADSTS700016: no such application there (never approved, or approval
# withdrawn by deleting it). AADSTS7000112: the application is disabled.
APP_NOT_APPROVED_CODES = frozenset({700016, 7000112})


def token_endpoint(tenant_id: str) -> str:
    return f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"


class TokenRequestRefused(RuntimeError):
    """The Microsoft identity platform refused to issue a token.

    `error_codes` carries the platform's own numeric codes, which are the only
    reliable way to tell a mistyped secret from an app nobody approved. Empty
    when the body did not say.
    """

    def __init__(self, message: str, *, error_codes: frozenset[int]) -> None:
        super().__init__(message)
        self.error_codes = error_codes

    @property
    def app_not_approved(self) -> bool:
        return bool(self.error_codes & APP_NOT_APPROVED_CODES)


class ClientCredential(Protocol):
    """How an app proves who it is when asking for a token.

    The form fields differ by credential, and a certificate's depend on where
    the request is going: its signed assertion names the token endpoint as its
    audience, so it is built per request.
    """

    async def form(self, *, app_id: str, token_url: str) -> dict[str, str]: ...


@dataclass(frozen=True)
class ClientSecret:
    secret: str

    async def form(self, *, app_id: str, token_url: str) -> dict[str, str]:
        return {"client_secret": self.secret}


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class ClientCertificate:
    """A certificate credential: a short-lived assertion signed with its key.

    Nothing secret leaves the process. Microsoft identifies the certificate by
    the thumbprints in the assertion's header and checks the signature against
    the public key uploaded to the app registration.
    """

    _ASSERTION_LIFETIME_SECONDS = 600

    def __init__(self, *, certificate_pem: str, private_key_pem: str) -> None:
        certificate = x509.load_pem_x509_certificate(certificate_pem.encode())
        der = certificate.public_bytes(serialization.Encoding.DER)
        self._headers = {
            "x5t#S256": _b64url(hashlib.sha256(der).digest()),
            # Older Entra endpoints read only the SHA-1 thumbprint; it names
            # the certificate and secures nothing, so carrying both is safe.
            "x5t": _b64url(hashlib.sha1(der, usedforsecurity=False).digest()),
        }
        self._key = serialization.load_pem_private_key(
            private_key_pem.encode(), password=None
        )

    async def form(self, *, app_id: str, token_url: str) -> dict[str, str]:
        now = int(time.time())
        assertion = jwt.encode(
            {
                "aud": token_url,
                "iss": app_id,
                "sub": app_id,
                "jti": str(uuid.uuid4()),
                "iat": now,
                "nbf": now,
                "exp": now + self._ASSERTION_LIFETIME_SECONDS,
            },
            self._key,  # type: ignore[arg-type]
            algorithm="PS256",
            headers=self._headers,
        )
        return {"client_assertion_type": _JWT_BEARER, "client_assertion": assertion}


@dataclass(frozen=True)
class FederatedTokenFile:
    """A workload-identity credential: a token another issuer wrote to a file.

    The file is projected into the pod and rotated by the platform, so it is
    read on every request rather than once.
    """

    path: str

    async def form(self, *, app_id: str, token_url: str) -> dict[str, str]:
        token = (await asyncio.to_thread(Path(self.path).read_text)).strip()
        if not token:
            raise TokenRequestRefused(
                f"The federated token file {self.path!r} is empty, so there is "
                "nothing to present to Microsoft in place of a secret.",
                error_codes=frozenset(),
            )
        return {"client_assertion_type": _JWT_BEARER, "client_assertion": token}


def _error_codes(resp: httpx.Response) -> frozenset[int]:
    try:
        codes = resp.json().get("error_codes") or []
        return frozenset(int(code) for code in codes)
    except (ValueError, TypeError, AttributeError):
        return frozenset()


class TeamsTokenProvider:
    """Acquires and caches app-only (client-credentials) tokens in one directory.

    One provider per directory: a bring-your-own bridge has one for its own
    directory, shared by the Bot Connector (outbound) and Graph
    (capture/provisioning) call paths; the distributed app has one for its own
    directory's Bot Connector tokens and one per customer directory for Graph.
    Each scope is cached independently with its own expiry. Tokens are refreshed
    a minute before expiry so an in-flight request never carries a just-expired
    token.
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        app_id: str,
        credential: ClientCredential,
        http: httpx.AsyncClient,
    ) -> None:
        self._token_url = token_endpoint(tenant_id)
        self._app_id = app_id
        self._credential = credential
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
                "scope": scope,
                **await self._credential.form(
                    app_id=self._app_id, token_url=self._token_url
                ),
            },
        )
        if resp.status_code != 200:
            raise TokenRequestRefused(
                f"AAD token request for scope {scope} failed "
                f"({resp.status_code}): {resp.text}",
                error_codes=_error_codes(resp),
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
            raise TokenRequestRefused(
                f"AAD token request for scope {scope} returned "
                f"{resp.status_code} with an unusable body: {resp.text[:500]}",
                error_codes=frozenset(),
            ) from exc
        expires_in = float(payload.get("expires_in", 3600))
        self._cache[scope] = (access_token, now + expires_in, now)
        return access_token

    async def bot_token(self) -> str:
        return await self.token(BOT_CONNECTOR_SCOPE)

    async def graph_token(self) -> str:
        return await self.token(GRAPH_SCOPE)

    async def graph_roles(self) -> frozenset[str]:
        """The Graph application permissions this directory has granted the app.

        Read from the token Microsoft just issued us, over TLS, so its claims
        are Microsoft's answer rather than anyone's assertion; the signature is
        not checked because a Graph token is not meant to be verified by its
        holder. A directory that withdrew a permission but kept the app still
        issues a token — one without that role — so this, not whether a token
        was issued, is what says the approval is intact.
        """
        # Graph access tokens are Microsoft's to verify, not their holder's:
        # Graph signs them with a nonce in the header that makes any other
        # party's signature check fail by design. This one is read only for
        # the claims Microsoft just issued to us, never to admit a caller.
        claims = jwt.decode(  # nosemgrep: python.jwt.security.unverified-jwt-decode.unverified-jwt-decode
            await self.graph_token(), options={"verify_signature": False}
        )
        roles = claims.get("roles") or []
        return frozenset(str(role) for role in roles)


@dataclass(frozen=True)
class SigningKey:
    key: Any
    #: The channels the key is endorsed for. The Bot Framework publishes this
    #: per key; the Microsoft identity platform does not, and leaves it empty.
    endorsements: frozenset[str]


class SigningKeys:
    """An OpenID provider's signing keys, fetched without blocking and cached.

    Asynchronous because the request that needs a key is being served on the
    event loop every tenant's traffic shares; a synchronous fetch there stalls
    all of it for as long as the provider takes to answer.
    """

    def __init__(self, *, metadata_url: str, http: httpx.AsyncClient) -> None:
        self._metadata_url = metadata_url
        self._http = http
        self._keys: dict[str, SigningKey] = {}
        # When the keys last arrived, which decides when they are stale, and
        # when a fetch was last tried at all, which decides when another may
        # be. Kept apart so a provider that is down is not asked again on
        # every request while the keys already held carry on working.
        self._fetched_at: float | None = None
        self._attempted_at: float | None = None
        self._lock = asyncio.Lock()

    def _may_attempt(self, now: float) -> bool:
        if self._attempted_at is None:
            return True
        # Holding nothing, a request cannot be answered at all, so a failed
        # first fetch is retried sooner than a refresh is.
        floor = _KEYS_REFETCH_FLOOR_SECONDS if self._keys else 30
        return now - self._attempted_at > floor

    async def get(self, kid: str) -> SigningKey:
        now = time.monotonic()
        fresh = (
            self._fetched_at is not None
            and now - self._fetched_at <= _KEYS_REFRESH_SECONDS
        )
        if fresh and kid in self._keys:
            return self._keys[kid]
        if self._may_attempt(now):
            async with self._lock:
                # Another request may have fetched while this one waited.
                if self._may_attempt(time.monotonic()):
                    await self._fetch()
        found = self._keys.get(kid)
        if found is None:
            raise PermissionError(f"token is signed with an unknown key ({kid!r})")
        return found

    async def _fetch(self) -> None:
        self._attempted_at = time.monotonic()
        try:
            metadata = await self._http.get(self._metadata_url)
            metadata.raise_for_status()
            jwks_uri = str(metadata.json()["jwks_uri"])
            published = await self._http.get(jwks_uri)
            published.raise_for_status()
            entries = published.json()["keys"]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            if self._keys:
                logger.warning(
                    "Could not refresh signing keys from %s (%s); keeping the "
                    "%d already held",
                    self._metadata_url,
                    error,
                    len(self._keys),
                )
                return
            raise PermissionError(
                f"could not fetch signing keys from {self._metadata_url}: {error}"
            ) from error
        keys: dict[str, SigningKey] = {}
        for entry in entries:
            kid = entry.get("kid")
            if not kid:
                continue
            try:
                key = jwt.PyJWK(entry).key
            except jwt.PyJWTError:
                continue
            keys[str(kid)] = SigningKey(
                key=key,
                endorsements=frozenset(str(e) for e in entry.get("endorsements") or []),
            )
        if not keys:
            if self._keys:
                logger.warning(
                    "%s published no usable signing keys; keeping the %d already held",
                    self._metadata_url,
                    len(self._keys),
                )
                return
            raise PermissionError(
                f"{self._metadata_url} published no usable signing keys"
            )
        self._keys = keys
        self._fetched_at = time.monotonic()


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise PermissionError("missing bearer token on inbound Teams activity")
    return authorization.split(" ", 1)[1].strip()


def _kid(token: str) -> str:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as error:
        raise PermissionError(f"token is not a JWT: {error}") from error
    if not kid:
        raise PermissionError("token names no signing key")
    return str(kid)


class BotFrameworkAuthenticator:
    """Checks the JWT the Bot Connector attaches to an inbound activity.

    Everything Microsoft's Bot Connector authentication spec requires of a
    bot: the token is signed by a key the Bot Framework publishes, issued by
    the Bot Framework, addressed to this app, current, endorsed for the channel
    the activity claims to come from, and naming the same `serviceUrl` the
    activity does. The last two are what stop a token minted for one channel
    or one region being replayed with an activity pointing elsewhere — and in
    the distributed app the `serviceUrl` is where this app's own token is then
    sent, so it is checked before anything is learned from it.
    """

    def __init__(self, *, app_id: str, keys: SigningKeys) -> None:
        self._app_id = app_id
        self._keys = keys

    async def verify(
        self,
        authorization: str | None,
        *,
        service_url: str,
        channel_id: str,
    ) -> None:
        """Raise `PermissionError` unless the activity's token is genuine."""
        token = _bearer(authorization)
        signing_key = await self._keys.get(_kid(token))
        try:
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self._app_id,
                issuer=BOTFRAMEWORK_ISSUER,
                leeway=_CLOCK_SKEW_SECONDS,
                options={"require": ["exp", "iss", "aud"]},
            )
        except jwt.InvalidAudienceError as exc:
            audience = self._describe_audience(token, signing_key.key)
            raise PermissionError(
                f"inbound Teams activity is addressed to {audience}, "
                f"but this bridge is configured with app id {self._app_id!r}. "
                "The Azure Bot resource's Microsoft App ID must be the app id "
                "registered on the bridge."
            ) from exc
        except jwt.PyJWTError as exc:
            raise PermissionError(
                f"inbound Teams activity token rejected: {exc}"
            ) from exc

        if channel_id not in signing_key.endorsements:
            raise PermissionError(
                f"the key that signed this activity is not endorsed for channel "
                f"{channel_id!r}"
            )
        claimed = claims.get("serviceurl")
        if claimed is None or str(claimed) != service_url:
            raise PermissionError(
                "the activity's serviceUrl does not match the one its token was "
                "issued for"
            )

    @staticmethod
    def _describe_audience(token: str, signing_key: Any) -> str:
        """The audience the token actually carries, for a mismatch message.

        Decoded with the same signing key, relaxing only the audience check —
        the one claim already known not to match. Reading it from an unverified
        parse would mean quoting an attacker's own words back in the message
        explaining why they were rejected, and the habit is worth not having
        even where, as here, the signature has just been checked.

        The audience of a Bot Connector token is an application id, not a
        secret; the token itself is never logged.
        """
        try:
            claims = jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                issuer=BOTFRAMEWORK_ISSUER,
                leeway=_CLOCK_SKEW_SECONDS,
                options={"verify_aud": False},
            )
        except jwt.PyJWTError:
            return "an unreadable audience"
        aud = claims.get("aud")
        return f"app id {aud!r}" if aud else "no audience"


class GraphNotificationAuthenticator:
    """Checks the `validationTokens` Graph attaches to notifications with data.

    One token per app and directory pair whose notifications share the POST.
    Each must be signed by the Microsoft identity platform, addressed to this
    app, issued to Graph's change-tracking application, and current. The
    directories they were issued in are the only ones the POST may carry
    notifications for: a `tenantId` in the body is otherwise just a claim.
    """

    def __init__(self, *, app_id: str, keys: SigningKeys) -> None:
        self._app_id = app_id
        self._keys = keys

    async def vouched_tenants(
        self, validation_tokens: Sequence[object]
    ) -> frozenset[str]:
        """The directories the tokens vouch for; raise if any token is not genuine."""
        tenants: set[str] = set()
        for raw in validation_tokens:
            token = str(raw)
            signing_key = await self._keys.get(_kid(token))
            try:
                claims = jwt.decode(
                    token,
                    signing_key.key,
                    algorithms=["RS256"],
                    audience=self._app_id,
                    leeway=_CLOCK_SKEW_SECONDS,
                    options={"require": ["exp", "aud", "iss"]},
                )
            except jwt.PyJWTError as exc:
                raise PermissionError(
                    f"Graph validation token rejected: {exc}"
                ) from exc
            caller = claims.get("azp") or claims.get("appid")
            if caller != GRAPH_CHANGE_TRACKING_APP_ID:
                raise PermissionError(
                    "Graph validation token was not issued to Graph's "
                    f"change-tracking application (got {caller!r})"
                )
            tenant = str(claims.get("tid") or "")
            if not tenant or not _issued_in(claims, tenant):
                raise PermissionError(
                    "Graph validation token names no directory, or one its "
                    "issuer does not"
                )
            tenants.add(tenant)
        return frozenset(tenants)


def _issued_in(claims: Mapping[str, object], tenant: str) -> bool:
    issuer = str(claims.get("iss") or "")
    return issuer in (
        f"https://sts.windows.net/{tenant}/",
        f"https://login.microsoftonline.com/{tenant}/v2.0",
    )


async def verify_microsoft_id_token(
    id_token: str, *, app_id: str, keys: SigningKeys
) -> dict[str, Any]:
    """Verify an id token the Microsoft identity platform issued to `app_id`.

    Raises `PermissionError` unless it is signed by one of the platform's keys,
    addressed to the app, current, and issued by the very organisation its
    `tid` names (`https://login.microsoftonline.com/{tid}/v2.0`).
    """
    signing_key = await keys.get(_kid(id_token))
    try:
        claims: dict[str, Any] = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256"],
            audience=app_id,
            leeway=_CLOCK_SKEW_SECONDS,
            options={"require": ["exp", "aud", "iss", "tid"]},
        )
    except jwt.PyJWTError as exc:
        raise PermissionError(f"id token rejected: {exc}") from exc
    tenant = str(claims.get("tid") or "")
    if claims.get("iss") != f"https://login.microsoftonline.com/{tenant}/v2.0":
        raise PermissionError("id token was not issued by the organisation it names")
    return claims
