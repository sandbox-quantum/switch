from __future__ import annotations

import json
import logging
from typing import Annotated, Any

import httpx
from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import RedirectResponse

from switch_core.config import SwitchConfig
from switch_core.db.stores.user_store import (
    OidcIdentityConflictError,
    OidcIdentityRaceError,
    UserStore,
)
from switch_core.gateway.auth import set_session_cookie
from switch_core.gateway.dependencies import get_config, get_session, get_user_store

logger = logging.getLogger(__name__)

router = APIRouter()

# Module-level OAuth registry. The single gateway client is registered once at
# app construction (see register_oidc_client) when OIDC is configured.
oauth = OAuth()
_CLIENT_NAME = "gateway_oidc"


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


@router.get("/auth/oidc/login")
async def oidc_login(
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
):
    if not config.gateway_oidc_enabled:
        raise HTTPException(status_code=404, detail="OIDC login is not configured")
    client = _client()
    # The redirect URI must exactly match the one registered with the IdP.
    # Behind a reverse proxy / Tailscale the request URL's scheme+host can't be
    # trusted, so prefer the explicitly configured value.
    redirect_uri = config.gateway_oidc_redirect_url or str(
        request.url_for("oidc_callback")
    )
    return await client.authorize_redirect(request, redirect_uri)


@router.get("/auth/oidc/callback", name="oidc_callback")
async def oidc_callback(
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
) -> RedirectResponse:
    if not config.gateway_oidc_enabled:
        raise HTTPException(status_code=404, detail="OIDC login is not configured")
    client = _client()
    try:
        # Server-side code→token exchange + id_token signature/nonce/aud
        # validation against the discovered JWKS.
        token = await client.authorize_access_token(request)
    except OAuthError as exc:
        logger.warning("OIDC callback failed: %s", exc)
        raise HTTPException(status_code=401, detail="OIDC authentication failed")

    claims = token.get("userinfo")
    if not claims:
        try:
            claims = await client.userinfo(token=token)
        except KeyError as exc:
            # authlib's userinfo() looks up metadata["userinfo_endpoint"],
            # which OIDC discovery makes optional. A provider that omits it
            # while also not returning an id_token leaves no way to read
            # claims at all — a configuration mistake (the wrong issuer for
            # this deployment), not a transient upstream fault, so retrying
            # won't help. Not a 500: that's for something unanticipated, and
            # this is diagnosed precisely enough to name.
            logger.error(
                "OIDC callback failed: the provider published no "
                "userinfo_endpoint and no id_token was returned, so there "
                "is nowhere to read claims from (%s)",
                exc,
            )
            raise HTTPException(
                status_code=503,
                detail="OIDC provider has no userinfo endpoint and issued no id_token",
            ) from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            # A non-2xx response, a transport failure (timeout, connection
            # refused), or a 200 whose body isn't JSON (a proxy or captive
            # portal in front of the provider) — the provider's fault, not
            # the caller's.
            logger.error("OIDC userinfo request failed: %s", exc)
            raise HTTPException(
                status_code=502, detail="OIDC provider did not respond"
            ) from exc
    email = claims.get("email")
    sub = claims.get("sub")
    if not email or not sub:
        logger.error("OIDC claims missing email/sub (got %s)", sorted(claims))
        raise HTTPException(
            status_code=401, detail="OIDC token missing email or sub claim"
        )
    # Provisioning trusts the email, so an unverified (attacker-set) one must
    # not be accepted — unless the deployment vouches for its IdP's addresses.
    email_verified = claims.get("email_verified")
    verified = email_verified is True or str(email_verified).lower() == "true"
    if not verified:
        if config.gateway_oidc_require_email_verified:
            logger.warning(
                "OIDC login rejected: email_verified=%r (sub %s). If this IdP's "
                "addresses are authoritative, set "
                "GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED=false.",
                email_verified,
                sub,
            )
            raise HTTPException(status_code=401, detail="OIDC email is not verified")
        logger.warning(
            "OIDC email_verified=%r accepted (sub %s): the email claim is trusted "
            "because GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED is false.",
            email_verified,
            sub,
        )
    name = claims.get("name") or email.split("@")[0]

    # A returning identity is looked up on the immutable issuer+subject, never
    # the mutable email; email only decides which account a *new* identity
    # lands in, and only once it's verified (see get_or_create_oidc_user).
    iss = claims.get("iss") or config.gateway_oidc_issuer_url
    if not iss:
        raise HTTPException(status_code=401, detail="OIDC token missing issuer")
    try:
        user = await user_store.get_or_create_oidc_user(
            session, iss=iss, email=email, name=name, sub=sub, email_verified=verified
        )
    except OidcIdentityConflictError as exc:
        logger.warning("OIDC identity conflict: %s", exc)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OidcIdentityRaceError as exc:
        # Transient contention, not a rejected security decision (see the
        # exception's docstring) — 503 so an operator's dashboards can tell
        # this apart from the 409s above rather than lumping a retry storm in
        # with attack signal.
        logger.warning("OIDC identity resolution raced: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Login is temporarily contended, please try again",
            headers={"Retry-After": "1"},
        ) from exc
    await session.commit()

    # Verify-at-login only: we don't persist the IdP tokens. Land the browser
    # back on the SPA with our own session cookie set.
    response = RedirectResponse(url=config.frontend_base_url or "/", status_code=303)
    set_session_cookie(
        response, user, config.jwt_secret_key, config.gateway_cookie_secure
    )
    return response
