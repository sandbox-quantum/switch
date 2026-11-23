from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.responses import JSONResponse, RedirectResponse

from switch_core.config import WORKOS_IDENTITY_ISSUER, SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, User
from switch_core.db.stores.identity_session_store import (
    IdentitySessionConflict,
    IdentitySessionStore,
)
from switch_core.db.stores.user_store import (
    OidcIdentityConflictError,
    OidcIdentityRaceError,
    SignupRefusedError,
    UserStore,
)
from switch_core.gateway.admission import writes_on_get
from switch_core.gateway.auth import (
    initial_tenant_claim,
    set_session_cookie,
    signed_in_now,
    signup_refused_by_edge,
)
from switch_core.gateway.dependencies import (
    current_telemetry,
    get_config,
    get_organization_directory,
    get_session_factory,
    get_system_session,
    get_user_store,
)
from switch_core.gateway.login_limits import client_address
from switch_core.gateway.sign_in_events import record_sign_in, sign_in_failed
from switch_core.organization_directory import (
    DirectoryUnavailable,
    OrganizationDirectory,
)
from switch_core.organization_mirror import bring_in_memberships
from switch_core.telemetry import emit_safely
from switch_core.tenant_context import tenant_scope
from switch_core.workos_authkit import (
    AuthKit,
    AuthKitOrganization,
    AuthKitRefused,
    AuthKitUnavailable,
)

logger = logging.getLogger(__name__)

_warned_unverified_claim = False

router = APIRouter()

# Module-level OAuth registry. The single gateway client is registered once at
# app construction (see register_oidc_client) when OIDC is configured.
oauth = OAuth()
_CLIENT_NAME = "gateway_oidc"

# Marks the second leg of the hop to the callback's host (`_callback_host_hop`),
# so a proxy that rewrites the Host header costs one redirect and not a loop.
_ON_CALLBACK_HOST = "on_callback_host"


def register_oidc_client(config: SwitchConfig) -> None:
    """Register the gateway OIDC client from config.

    Endpoints (authorize / token / jwks / issuer) are discovered from the
    provider's well-known metadata, so this works against any standards
    compliant IdP (Okta, Keycloak, Auth0, …) — bring-your-own.
    """
    oauth.register(
        name=_CLIENT_NAME,
        server_metadata_url=config.gateway_oidc_metadata_url,
        client_id=config.gateway_oidc_client_id,
        client_secret=config.gateway_oidc_client_secret,
        client_kwargs={"scope": config.gateway_oidc_scopes},
    )


def _client() -> Any:
    # authlib is untyped here; the returned StarletteOAuth2App exposes
    # authorize_redirect / authorize_access_token / userinfo.
    client = oauth.create_client(_CLIENT_NAME)
    if client is None:
        raise HTTPException(status_code=404, detail="OIDC login is not configured")
    return client


def _callback_host_hop(request: Request, redirect_url: str | None) -> str | None:
    """Where to restart a sign-in begun on another host than the callback's.

    The flow's state is kept in a cookie on the host the browser starts on, and
    the identity provider returns the browser to `redirect_url`. A server that
    answers on two hosts, its own serving the dashboard beside a separate
    dashboard host the provider still returns to, would lose the state on the
    way back. Hostnames only: a cookie is shared across ports, and a proxy may
    drop the port from the Host header. None to start the flow here.
    """
    if not redirect_url:
        return None
    callback = urlsplit(redirect_url)
    if callback.hostname == request.url.hostname:
        return None
    if request.query_params.get(_ON_CALLBACK_HOST):
        logger.warning(
            "OIDC login reached %s after being sent to %s, the host the identity "
            "provider returns to; a proxy may be rewriting the Host header. "
            "Starting the sign-in here, where it may lose its state on return.",
            request.url.hostname,
            callback.hostname,
        )
        return None
    # The sign-in's own parameters go with it: a sign-in option, or the
    # hand-back to an app on this computer, starts over there unchanged.
    query = [
        (key, value)
        for key, value in request.query_params.multi_items()
        if key != _ON_CALLBACK_HOST
    ]
    query.append((_ON_CALLBACK_HOST, "1"))
    return urlunsplit(
        (
            callback.scheme,
            callback.netloc,
            request.url_for("oidc_login").path,
            urlencode(query),
            "",
        )
    )


# ── Handing a sign-in back to an app on this computer ────────────────────────
#
# Switch Console signs in through the system browser: it listens on the
# loopback address, opens `/auth/oidc/login` with `return_to` pointing there,
# and the browser comes back to it with a one-time code instead of a session
# cookie the app could not read. The code is only good with the verifier the
# app kept to itself (its SHA-256 is the `challenge` it sent), and only for a
# couple of minutes, so a code seen by anything else on the way is useless.

_HANDOFF_SESSION_KEY = "oidc_handoff"
_HANDOFF_PATH = "/switch-sign-in"
_HANDOFF_TTL_SECONDS = 120
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_VERIFIER = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


def _loopback_return_to(value: str) -> str:
    """`value` if it is the app's loopback listener, else a refusal: the code
    goes only to this computer, never to an address someone else chose."""
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        port = None
        parts = None
    if (
        parts is None
        or parts.scheme != "http"
        or parts.hostname not in _LOOPBACK_HOSTS
        or port is None
        or parts.username is not None
        or parts.password is not None
        or parts.path != _HANDOFF_PATH
        or parts.query
        or parts.fragment
    ):
        raise HTTPException(
            status_code=400,
            detail=f"return_to must be http://127.0.0.1:<port>{_HANDOFF_PATH}",
        )
    return value


def _challenge_of(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


async def _bring_in_organizations(
    session_factory: async_sessionmaker[AsyncSession],
    organization_directory: OrganizationDirectory,
    user: User,
    subject: str,
) -> None:
    """Bring the person's organization memberships up to date with a directory
    kept outside Switch (`organization_mirror.py`). Neither a directory that
    can't be read nor a failure writing Switch's rows stops the sign-in:
    authorization reads Switch's rows, each organization's change commits on
    its own, and an organization left behind is caught up at the next
    sign-in. Both are logged."""
    try:
        memberships = await organization_directory.memberships_at_sign_in(subject)
    except DirectoryUnavailable as error:
        logger.warning(
            "Could not read user %s's organizations at sign-in; Switch's are "
            "left as they were: %s",
            user.id,
            error.message,
        )
        return
    if memberships is None:
        return
    try:
        await bring_in_memberships(session_factory, user.id, memberships)
    except SQLAlchemyError:
        logger.exception(
            "Could not bring user %s's organizations up to date at sign-in; "
            "some of Switch's may be behind the directory",
            user.id,
        )


# ── Where a sign-in lands ────────────────────────────────────────────────────

_NEXT_LIMIT = 2048
# What WorkOS adds when it sends the browser to the Initiate login URI for a
# sign-in to continue (an invitation, an organization's own sign-in, a login
# hint), forwarded to AuthKit's sign-in as they came.
_FORWARDED = ("invitation_token", "organization_id", "login_hint")
_FORWARDED_VALUE = re.compile(r"^[A-Za-z0-9_.@+-]{1,512}$")


def _dashboard_location(value: str | None) -> str | None:
    """`value` as a location on the dashboard to land on after signing in,
    query kept and fragment dropped, or None when it is not one: anything
    with a scheme or host, or that a browser could read as another host
    (`//`, `\\`), lands on the dashboard's home instead."""
    if value is None or not value or len(value) > _NEXT_LIMIT:
        return None
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme or parts.netloc:
        return None
    return urlunsplit(("", "", parts.path, parts.query, ""))


def _on_dashboard(config: SwitchConfig, location: str) -> str:
    """`location` on the dashboard a sign-in lands on: its own host when it
    has one (`FRONTEND_BASE_URL`), else this one, where the session cookie
    was just set."""
    base = (config.frontend_base_url or "").rstrip("/")
    return f"{base}{location}"


class SignInError(Exception):
    """A sign-in that did not finish, and why, as the dashboard's sign-in page
    names it (`?sign_in_error=`): `cancelled`, `refused`, `expired`,
    `email_unverified`, `account_conflict`, `signup_refused`,
    `impersonation`, `unavailable` or `misconfigured`. Logged where raised."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _sign_in_failed(config: SwitchConfig, error: SignInError) -> RedirectResponse:
    """Back to the sign-in page, saying why, rather than a bare error. The page
    then waits to be asked rather than handing off again."""
    query = urlencode({"sign_in_error": error.code})
    return RedirectResponse(
        url=_on_dashboard(config, f"/login?{query}"), status_code=303
    )


@dataclass(frozen=True)
class _Pending:
    """What a sign-in carries across the identity provider's round trip: a
    hand-back to an app on this computer, and where to land."""

    handoff: dict[str, str] | None
    next: str | None


@dataclass(frozen=True)
class _Identity:
    """Who the identity provider says signed in."""

    iss: str
    sub: str
    email: str
    email_verified: bool
    name: str
    # The generic client's identities from before issuers were tracked are
    # matched on their subject alone; AuthKit's never are.
    match_legacy: bool
    # The provider session the sign-in stands on (WorkOS AuthKit only).
    provider_session: str | None


# ── Starting a sign-in ───────────────────────────────────────────────────────


def _handoff_from(
    return_to: str | None, state: str | None, challenge: str | None
) -> dict[str, str] | None:
    handoff = (return_to, state, challenge)
    if all(part is None for part in handoff):
        return None
    if return_to is None or state is None or challenge is None:
        raise HTTPException(
            status_code=400,
            detail="return_to, state and challenge are given together",
        )
    if not _TOKEN.match(state) or not _CHALLENGE.match(challenge):
        raise HTTPException(status_code=400, detail="Malformed state or challenge")
    return {
        "return_to": _loopback_return_to(return_to),
        "state": state,
        "challenge": challenge,
    }


def _login_option_params(config: SwitchConfig, provider: str | None) -> dict[str, str]:
    if provider is None:
        return {}
    option = next(
        (o for o in config.gateway_oidc_login_options if o.id == provider), None
    )
    if option is None:
        raise HTTPException(
            status_code=400, detail=f"Unknown sign-in option: {provider}"
        )
    return dict(option.params)


def _redirect_uri(request: Request, config: SwitchConfig) -> str:
    # The redirect URI must exactly match the one registered with the IdP.
    # Behind a reverse proxy / Tailscale the request URL's scheme+host can't be
    # trusted, so prefer the explicitly configured value.
    return config.gateway_oidc_redirect_url or str(request.url_for("oidc_callback"))


@router.get("/auth/oidc/login", name="oidc_login")
async def oidc_login(
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
    provider: str | None = None,
    return_to: str | None = None,
    state: str | None = None,
    challenge: str | None = None,
    next: str | None = None,
    restart: str | None = None,
):
    """Start a sign-in. `provider` picks one of the configured login options;
    `return_to`, `state` and `challenge` together hand the result back to an
    app on this computer rather than setting a cookie in this browser; `next`
    is where on the dashboard to land.

    Under WorkOS AuthKit this is also the application's Initiate login URI:
    WorkOS sends a sign-in that did not start here (an invitation, a password
    reset, the organization's own sign-in) to it, with what it needs to
    continue, and it is passed on to AuthKit."""
    if not config.gateway_sso_enabled:
        raise HTTPException(status_code=404, detail="OIDC login is not configured")
    hop = _callback_host_hop(request, config.gateway_oidc_redirect_url)
    if hop is not None:
        return RedirectResponse(url=hop, status_code=302)
    params = _login_option_params(config, provider)
    pending = _Pending(
        _handoff_from(return_to, state, challenge), _dashboard_location(next)
    )
    if config.gateway_workos_sign_in:
        forwarded: dict[str, str] = {}
        for name in _FORWARDED:
            value = request.query_params.get(name)
            if value is None:
                continue
            if not _FORWARDED_VALUE.match(value):
                raise HTTPException(status_code=400, detail=f"Malformed {name}")
            forwarded[name] = value
        return _authkit_login(
            request, config, pending, forwarded, restarted=restart is not None
        )
    client = _client()
    if pending.handoff is not None:
        request.session[_HANDOFF_SESSION_KEY] = pending.handoff
    else:
        request.session.pop(_HANDOFF_SESSION_KEY, None)
    if pending.next is not None:
        request.session[_NEXT_SESSION_KEY] = pending.next
    else:
        request.session.pop(_NEXT_SESSION_KEY, None)
    return await client.authorize_redirect(
        request, _redirect_uri(request, config), **params
    )


# ── WorkOS AuthKit ───────────────────────────────────────────────────────────
#
# AuthKit's own sign-in, PKCE on the server. Each sign-in under way is kept in
# the login cookie under its state, so two in one browser do not overwrite
# each other; at most `_PENDING_LIMIT`, so the cookie stays small. A state
# that comes back unknown (the cookie expired during a long password reset,
# say) restarts the sign-in once; the restart's state is marked, so a cookie
# that never comes back cannot loop with AuthKit's silent sign-in.

_AUTHKIT_SESSION_KEY = "authkit_sign_ins"
_PENDING_LIMIT = 2
_PENDING_TTL_SECONDS = 600
_RESTARTED = "r."


def _authkit_of(request: Request) -> AuthKit:
    found = getattr(request.app.state, "authkit", None)
    if not isinstance(found, AuthKit):
        raise RuntimeError(
            "GATEWAY_SIGN_IN_PROVIDER=workos, but no AuthKit client is set up"
        )
    return found


def _authkit_login(
    request: Request,
    config: SwitchConfig,
    pending: _Pending,
    forwarded: dict[str, str],
    *,
    restarted: bool,
) -> RedirectResponse:
    state = (_RESTARTED if restarted else "") + secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    now = int(time.time())
    sign_ins = {
        key: value
        for key, value in dict(request.session.get(_AUTHKIT_SESSION_KEY) or {}).items()
        if isinstance(value, dict)
        and int(value.get("at", 0)) > now - _PENDING_TTL_SECONDS
    }
    sign_ins[state] = {
        "verifier": verifier,
        "handoff": pending.handoff,
        "next": pending.next,
        "at": now,
    }
    newest = sorted(sign_ins.items(), key=lambda item: item[1]["at"])[-_PENDING_LIMIT:]
    request.session[_AUTHKIT_SESSION_KEY] = dict(newest)
    return RedirectResponse(
        url=_authkit_of(request).authorize_url(
            redirect_uri=_redirect_uri(request, config),
            state=state,
            challenge=_challenge_of(verifier),
            extra=forwarded,
        ),
        status_code=302,
    )


def _client_ip(request: Request) -> str | None:
    """The address a sign-in came from, for WorkOS's bot protection: the
    client's own, as uvicorn resolved it behind the proxies it trusts
    (`FORWARDED_ALLOW_IPS`), or None rather than a proxy's
    (`login_limits.client_address`)."""
    address = client_address(request)
    return None if address is None else str(address)


async def _first_organization(organizations: list[AuthKitOrganization]) -> str | None:
    # Switch keeps no WorkOS token, so the organization an AuthKit session is
    # signed in to changes nothing here: memberships are read from WorkOS on
    # their own (`_bring_in_organizations`). Any one listed lets the sign-in
    # finish.
    return organizations[0].id if organizations else None


async def _authkit_identity(
    request: Request, config: SwitchConfig
) -> tuple[_Identity, _Pending] | RedirectResponse:
    state = request.query_params.get("state") or ""
    sign_ins = dict(request.session.get(_AUTHKIT_SESSION_KEY) or {})
    kept = sign_ins.pop(state, None)
    request.session[_AUTHKIT_SESSION_KEY] = sign_ins
    error = request.query_params.get("error")
    if error is not None:
        logger.info(
            "AuthKit sign-in came back with %s: %s",
            error,
            request.query_params.get("error_description"),
        )
        raise SignInError("cancelled" if error == "access_denied" else "refused")
    code = request.query_params.get("code")
    if not code:
        raise SignInError("refused")
    if (
        not isinstance(kept, dict)
        or int(kept.get("at", 0)) <= int(time.time()) - _PENDING_TTL_SECONDS
    ):
        if state.startswith(_RESTARTED):
            logger.warning(
                "AuthKit sign-in came back twice with a state this browser did "
                "not keep; is the login cookie being dropped (a proxy rewriting "
                "the Host header, or a Secure cookie over http)?"
            )
            raise SignInError("expired")
        return RedirectResponse(
            url=f"{request.url_for('oidc_login').path}?restart=1", status_code=303
        )
    pending = _Pending(kept.get("handoff"), kept.get("next"))
    try:
        signed_in = await _authkit_of(request).authenticate(
            code=code,
            verifier=str(kept["verifier"]),
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
            choose_organization=_first_organization,
        )
    except AuthKitRefused as refused:
        logger.warning(
            "AuthKit refused the sign-in (%s): %s", refused.code, refused.message
        )
        raise SignInError("refused") from refused
    except AuthKitUnavailable as unavailable:
        logger.error("AuthKit sign-in could not finish: %s", unavailable.message)
        raise SignInError("unavailable") from unavailable
    if signed_in.impersonator is not None:
        logger.warning(
            "Refused a WorkOS impersonation of user %s by %s: Switch does not "
            "accept impersonated sign-ins",
            signed_in.user_id,
            signed_in.impersonator,
        )
        raise SignInError("impersonation")
    return (
        _Identity(
            iss=WORKOS_IDENTITY_ISSUER,
            sub=signed_in.user_id,
            email=signed_in.email,
            email_verified=signed_in.email_verified,
            name=signed_in.name or signed_in.email.split("@")[0],
            match_legacy=False,
            provider_session=signed_in.session_id,
        ),
        pending,
    )


# ── The generic OIDC client ──────────────────────────────────────────────────

_NEXT_SESSION_KEY = "oidc_next"


async def _oidc_identity(request: Request, config: SwitchConfig) -> _Identity:
    client = _client()
    try:
        # Server-side code→token exchange + id_token signature/nonce/aud
        # validation against the discovered JWKS.
        token = await client.authorize_access_token(request)
    except OAuthError as exc:
        logger.warning("OIDC callback failed: %s", exc)
        if exc.error == "access_denied":
            raise SignInError("cancelled") from exc
        if exc.error == "mismatching_state":
            raise SignInError("expired") from exc
        raise SignInError("refused") from exc

    claims = token.get("userinfo")
    if not claims:
        try:
            claims = await client.userinfo(token=token)
        except KeyError as exc:
            # authlib's userinfo() looks up metadata["userinfo_endpoint"],
            # which OIDC discovery makes optional. We only reach this call
            # because token["userinfo"] was falsy, which authlib sets only
            # when both an id_token and the stored nonce were present — so
            # that can mean no id_token came back, or one did but the nonce
            # didn't match. Either way, a provider that also has no
            # userinfo_endpoint leaves no way to read claims at all — a
            # configuration mistake (the wrong issuer for this deployment),
            # not a transient upstream fault, so retrying won't help.
            logger.error(
                "OIDC callback failed: the provider published no "
                "userinfo_endpoint and no claims were available from the "
                "token, so there is nowhere to read claims from (%s)",
                exc,
            )
            raise SignInError("misconfigured") from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            # A non-2xx response, a transport failure (timeout, connection
            # refused), or a 200 whose body isn't JSON (a proxy or captive
            # portal in front of the provider) — the provider's fault, not
            # the caller's.
            logger.error("OIDC userinfo request failed: %s", exc)
            raise SignInError("unavailable") from exc
    email = claims.get("email")
    sub = claims.get("sub")
    if not email or not sub:
        logger.error("OIDC claims missing email/sub (got %s)", sorted(claims))
        raise SignInError("misconfigured")
    email_verified = claims.get("email_verified")
    # A returning identity is looked up on the immutable issuer+subject, never
    # the mutable email; email only decides which account a *new* identity
    # lands in, and only once it's verified (see get_or_create_oidc_user).
    iss = claims.get("iss") or config.gateway_oidc_issuer_url
    if not iss:
        logger.error("OIDC sign-in refused: the token names no issuer")
        raise SignInError("misconfigured")
    # Under the WorkOS directory every other reader of these identities (the
    # mirror, the organization sign-in, `switch-link-workos`) looks them up
    # under the issuer as configured. An identity stored under another
    # spelling of it would match none of them, so a mismatch is a
    # configuration mistake to name, not a sign-in to let through.
    if (
        config.organization_directory == "workos"
        and iss != config.gateway_oidc_issuer_url
    ):
        logger.error(
            "OIDC sign-in refused: the token's issuer %r is not "
            "GATEWAY_OIDC_ISSUER_URL %r exactly, which the WorkOS directory "
            "looks identities up under; set it to the token's issuer",
            iss,
            config.gateway_oidc_issuer_url,
        )
        raise SignInError("misconfigured")
    return _Identity(
        iss=iss,
        sub=sub,
        email=email,
        email_verified=email_verified is True or str(email_verified).lower() == "true",
        name=claims.get("name") or email.split("@")[0],
        match_legacy=True,
        provider_session=None,
    )


def _oidc_pending(request: Request) -> _Pending:
    handoff = request.session.pop(_HANDOFF_SESSION_KEY, None)
    return _Pending(
        handoff if isinstance(handoff, dict) else None,
        _dashboard_location(request.session.pop(_NEXT_SESSION_KEY, None)),
    )


# ── Finishing a sign-in, either way ──────────────────────────────────────────


def _require_verified(config: SwitchConfig, identity: _Identity) -> None:
    # Provisioning trusts the email, so an unverified (attacker-set) one must
    # not be accepted — unless the deployment vouches for its IdP's addresses.
    if identity.email_verified:
        return
    if config.gateway_oidc_require_email_verified:
        logger.warning(
            "Sign-in refused: the identity provider does not say the email is "
            "verified (sub %s). If this IdP's addresses are authoritative, set "
            "GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED=false.",
            identity.sub,
        )
        raise SignInError("email_unverified")
    # A setting, not an event: said once per process as a warning, then at
    # debug for each sign-in it applies to.
    global _warned_unverified_claim
    logger.log(
        logging.DEBUG if _warned_unverified_claim else logging.WARNING,
        "Unverified email accepted (sub %s): the email claim is trusted because "
        "GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED is false.",
        identity.sub,
    )
    _warned_unverified_claim = True


async def _provision(
    request: Request,
    config: SwitchConfig,
    session: AsyncSession,
    user_store: UserStore,
    identity: _Identity,
) -> tuple[User, bool]:
    """The account `identity` signs in to, and whether this made it."""
    # A first sign-in provisions the account just in time. Where it lands is
    # `gateway_signup_mode`'s decision. Under "default_tenant" it joins tenant
    # zero, named here rather than left to `TenantScoped`'s fallback, which
    # would produce the same row by accident rather than by decision. Under
    # the self-service modes it joins nothing: `users` and `oidc_identities`
    # are global, so provisioning needs no tenant bound, and the newcomer is
    # sent to onboarding to create a workspace or accept an invitation.
    join_tenant = config.gateway_signup_mode == "default_tenant"
    scope: AbstractContextManager[None] = (
        tenant_scope(TENANT_ZERO_ID) if join_tenant else nullcontext()
    )
    with scope:
        try:
            user, created = await user_store.get_or_create_oidc_user(
                session,
                iss=identity.iss,
                email=identity.email,
                name=identity.name,
                sub=identity.sub,
                email_verified=identity.email_verified,
                join_tenant=join_tenant,
                link_by_email=config.organization_directory == "local",
                create_allowed=not signup_refused_by_edge(request, config),
                match_legacy=identity.match_legacy,
            )
        except SignupRefusedError as exc:
            await session.rollback()
            logger.warning(
                "First sign-in refused (sub %s): the request is marked as from a "
                "country without sign-up",
                identity.sub,
            )
            emit_safely(current_telemetry(), "signup_refused", {"reason": "country"})
            raise SignInError("signup_refused") from exc
        except OidcIdentityConflictError as exc:
            await session.rollback()
            logger.warning("Sign-in identity conflict: %s", exc)
            raise SignInError("account_conflict") from exc
        except OidcIdentityRaceError as exc:
            # Transient contention, not a rejected security decision (see the
            # exception's docstring).
            await session.rollback()
            logger.warning("Sign-in identity resolution raced: %s", exc)
            raise SignInError("unavailable") from exc
        await session.commit()
    if created:
        emit_safely(current_telemetry(), "account_created", {"method": "oidc"})
    return user, created


async def _record_identity_session(
    session: AsyncSession, user: User, identity: _Identity
) -> str | None:
    if identity.provider_session is None:
        return None
    try:
        row_id = await IdentitySessionStore().record(
            session,
            user_id=user.id,
            provider="workos",
            provider_user_id=identity.sub,
            session_id=identity.provider_session,
            followed=True,
            now=datetime.now(UTC),
        )
    except IdentitySessionConflict as exc:
        await session.rollback()
        logger.error("Sign-in refused: %s", exc)
        raise SignInError("refused") from exc
    await session.commit()
    return row_id


@router.get(
    "/auth/oidc/callback", name="oidc_callback", dependencies=[Depends(writes_on_get)]
)
async def oidc_callback(
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
) -> RedirectResponse:
    """A sign-in coming back from the identity provider. A sign-in that does
    not finish lands on the dashboard's sign-in page, saying why
    (`SignInError`), rather than on a bare error."""
    # `get_system_session`: nobody is signed in yet, so there is no principal
    # to take a tenant from — the tenant this route writes into is chosen
    # below, deliberately.
    if not config.gateway_sso_enabled:
        raise HTTPException(status_code=404, detail="OIDC login is not configured")
    method = "authkit" if config.gateway_workos_sign_in else "oidc"
    try:
        if config.gateway_workos_sign_in:
            outcome = await _authkit_identity(request, config)
            if isinstance(outcome, RedirectResponse):
                return outcome
            identity, pending = outcome
        else:
            pending = _oidc_pending(request)
            identity = await _oidc_identity(request, config)
        _require_verified(config, identity)
        user, created = await _provision(request, config, session, user_store, identity)
        identity_session = await _record_identity_session(session, user, identity)
    except SignInError as error:
        sign_in_failed(
            request, method=method, reason=error.code, user_id=None, tenant_id=None
        )
        return _sign_in_failed(config, error)
    await _bring_in_organizations(
        session_factory, organization_directory, user, identity.sub
    )
    await record_sign_in(
        session,
        request,
        user_id=user.id,
        method=method,
        details={"account_created": created, "handoff": pending.handoff is not None},
    )
    await session.commit()

    if pending.handoff is not None:
        # The app on this computer that started the sign-in takes it from
        # here: the browser goes back to it with a code, and no cookie.
        code = config.keyring.encrypt(
            json.dumps(
                {
                    "user_id": user.id,
                    "challenge": pending.handoff["challenge"],
                    "isid": identity_session,
                    "exp": int(time.time()) + _HANDOFF_TTL_SECONDS,
                }
            )
        )
        query = urlencode({"code": code, "state": pending.handoff["state"]})
        return RedirectResponse(
            url=f"{pending.handoff['return_to']}?{query}", status_code=303
        )
    # Land the browser back on the SPA with our own session cookie set: on this
    # host, where the cookie is, unless FRONTEND_BASE_URL names the dashboard's
    # origin. Not `dashboard_base_url`, whose default is the server's public
    # origin, which on a split deployment is not the host the provider
    # returned to.
    response = RedirectResponse(
        url=_on_dashboard(config, pending.next or "/"), status_code=303
    )
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        await initial_tenant_claim(session_factory, user_store, user),
        signed_in_now(identity_session),
    )
    return response


class HandoffExchange(BaseModel):
    code: str
    verifier: str


@router.post("/auth/oidc/exchange")
async def oidc_exchange(
    req: HandoffExchange,
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
    session: Annotated[AsyncSession, Depends(get_system_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> JSONResponse:
    """Trade a code a sign-in handed back to this computer for a session:
    only with the verifier its challenge was made from, and only while fresh."""
    refused = HTTPException(status_code=400, detail="The sign-in code is not valid")

    def refuse(reason: str) -> HTTPException:
        sign_in_failed(
            request,
            method="oidc_handoff",
            reason=reason,
            user_id=None,
            tenant_id=None,
        )
        return refused

    if len(req.code) > 4096 or not _VERIFIER.match(req.verifier):
        raise refuse("malformed")
    try:
        payload = json.loads(config.keyring.decrypt(req.code))
    except Exception as exc:
        raise refuse("undecryptable") from exc
    if not isinstance(payload, dict) or int(payload.get("exp", 0)) < int(time.time()):
        raise refuse("expired")
    if not hmac.compare_digest(
        str(payload.get("challenge", "")), _challenge_of(req.verifier)
    ):
        raise refuse("verifier_mismatch")
    user = await session.get(User, str(payload.get("user_id", "")))
    if user is None:
        raise refuse("unknown_account")
    identity_session = payload.get("isid")
    response = JSONResponse({"ok": True})
    set_session_cookie(
        response,
        user,
        config.keyring,
        config.gateway_cookie_secure,
        await initial_tenant_claim(session_factory, user_store, user),
        signed_in_now(identity_session if isinstance(identity_session, str) else None),
    )
    return response
