"""Signing an admin in to their linked organization's WorkOS account, for the
token the members service takes changes from (`workos_sign_in.py`).

The dashboard sends the browser here when a change to the members answers
`directory_sign_in_required`, and comes back to `return_to` to make it again.
The token is kept in the sign-in cookie, encrypted and bound to the Switch
account that asked for it, and is offered to a change only while it lasts.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import secrets
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import RedirectResponse

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.config import SwitchConfig
from switch_core.db.models import (
    Organization,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_organization_directory,
    get_session,
    get_user_store,
)
from switch_core.organization_directory import (
    DirectoryUnavailable,
    OrganizationDirectory,
)
from switch_core.workos_sign_in import (
    OrganizationToken,
    SignInRefused,
    WorkOSOrganizationSignIn,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_PENDING_KEY = "workos_organization_sign_in"
_TOKEN_KEY = "workos_organization_token"
# A change is started only with a token that outlasts it: a demotion or a
# removal ends workspace access, one workspace at a time, before the members
# service is called.
_TOKEN_MARGIN_SECONDS = 120
# A dashboard path, and nothing that could leave it: no `//`, which a browser
# reads as another host.
_RETURN_TO = re.compile(r"^/(?!/)[A-Za-z0-9/_.-]*$")


def _sign_in(request: Request) -> WorkOSOrganizationSignIn:
    sign_in: WorkOSOrganizationSignIn | None = request.app.state.workos_sign_in
    if sign_in is None:
        raise HTTPException(
            status_code=404,
            detail="Changes to organization members are not sent to WorkOS here",
        )
    return sign_in


async def directory_subject(
    session: AsyncSession,
    user_store: UserStore,
    organization_directory: OrganizationDirectory,
    user_id: str,
) -> str | None:
    """The directory's id for `user_id`: their subject under its
    `identity_issuer`, or None where it has none or they have no identity
    there. What the admin's token must be issued to, and what a change to
    someone's membership names them by."""
    if organization_directory.identity_issuer is None:
        return None
    return await user_store.oidc_subject(
        session, user_id, organization_directory.identity_issuer
    )


@router.get("/auth/workos/organization")
async def start_organization_sign_in(
    request: Request,
    return_to: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> RedirectResponse:
    """Send the signed-in Org Admin to sign in to the WorkOS organization the
    bound workspace's organization follows, and back to `return_to`."""
    sign_in = _sign_in(request)
    if not _RETURN_TO.match(return_to):
        raise HTTPException(
            status_code=400, detail="return_to must be a dashboard path"
        )
    tenant_id = require_tenant_id()
    if await user_store.organization_role(session, tenant_id, user.id) != (
        ORGANIZATION_ADMIN_ROLE
    ):
        raise HTTPException(
            status_code=403, detail="Only an organization admin may do this"
        )
    tenant = await session.get(Tenant, tenant_id)
    organization = (
        await session.get(Organization, tenant.organization_id)
        if tenant is not None and tenant.organization_id is not None
        else None
    )
    if organization is None or organization.workos_organization_id is None:
        raise HTTPException(
            status_code=409, detail="This organization does not follow WorkOS"
        )
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(24)
    request.session[_PENDING_KEY] = {
        "state": state,
        "verifier": verifier,
        "user_id": user.id,
        "workos_organization_id": organization.workos_organization_id,
        "return_to": return_to,
    }
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return RedirectResponse(
        url=sign_in.authorize_url(
            organization.workos_organization_id, state, challenge
        ),
        status_code=302,
    )


@router.get("/auth/workos/callback")
async def finish_organization_sign_in(
    request: Request,
    code: str,
    state: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    organization_directory: Annotated[
        OrganizationDirectory, Depends(get_organization_directory)
    ],
    user: Annotated[User, Depends(get_current_user)],
) -> RedirectResponse:
    """Exchange the code for the admin's token, once it is shown to be theirs
    and for the organization they were sent to, and go back to `return_to`."""
    sign_in = _sign_in(request)
    pending = request.session.pop(_PENDING_KEY, None)
    if (
        not isinstance(pending, dict)
        or not secrets.compare_digest(str(pending.get("state", "")), state)
        or pending.get("user_id") != user.id
    ):
        raise HTTPException(
            status_code=400,
            detail="This sign-in was not started here, or has expired; try again",
        )
    try:
        token = await sign_in.authenticate(code, str(pending["verifier"]))
    except SignInRefused as error:
        logger.warning(
            "WorkOS organization sign-in refused for user %s: %s", user.id, error
        )
        raise HTTPException(
            status_code=401, detail="WorkOS refused the sign-in; try again"
        ) from error
    except DirectoryUnavailable as error:
        logger.warning("WorkOS organization sign-in failed: %s", error.message)
        raise HTTPException(status_code=503, detail=error.message) from error
    if token.subject != await directory_subject(
        session, user_store, organization_directory, user.id
    ):
        logger.warning(
            "User %s signed in to WorkOS as %s, which is not the WorkOS user "
            "their account signs in as; the token is dropped",
            user.id,
            token.subject,
        )
        raise HTTPException(
            status_code=403,
            detail=(
                "You signed in to WorkOS as someone else than this Switch "
                "account; sign in as yourself"
            ),
        )
    if token.workos_organization_id != pending["workos_organization_id"]:
        raise HTTPException(
            status_code=403,
            detail="WorkOS signed you in to another organization; try again",
        )
    request.session[_TOKEN_KEY] = config.keyring.encrypt(
        json.dumps(
            {
                "user_id": user.id,
                "subject": token.subject,
                "workos_organization_id": token.workos_organization_id,
                "access_token": token.access_token,
                "expires_at": token.expires_at,
            }
        )
    )
    origin = urlsplit(config.frontend_base_url or "")
    base = f"{origin.scheme}://{origin.netloc}" if origin.netloc else ""
    return RedirectResponse(url=f"{base}{pending['return_to']}", status_code=303)


def directory_access_token(
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
) -> OrganizationToken | None:
    """The signed-in admin's WorkOS token from `finish_organization_sign_in`,
    while it is theirs and lasts beyond the change about to be made."""
    sealed = request.session.get(_TOKEN_KEY)
    if not isinstance(sealed, str):
        return None
    try:
        kept = json.loads(config.keyring.decrypt(sealed))
    except Exception:
        logger.warning("A kept WorkOS organization token could not be read; dropped")
        request.session.pop(_TOKEN_KEY, None)
        return None
    if not isinstance(kept, dict) or kept.get("user_id") != user.id:
        return None
    token = OrganizationToken(
        subject=str(kept["subject"]),
        workos_organization_id=str(kept["workos_organization_id"]),
        access_token=str(kept["access_token"]),
        expires_at=int(kept["expires_at"]),
    )
    return token if token.lasts_beyond(_TOKEN_MARGIN_SECONDS) else None
