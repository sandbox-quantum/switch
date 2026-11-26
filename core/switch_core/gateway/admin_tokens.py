"""The signed-in person's own access to their organization's account, for
what its account service takes only from them (`members_service.py`):
changing its members, and creating it.

An admin signs in once, through WorkOS AuthKit, and that sign-in's refresh
token is kept with the identity session their cookie stands on
(`gateway/identity_sessions.py`). When a change needs the admin's token for
the organization, it is renewed from there for that organization alone
(`IdentitySessions.organization_token`), so nobody is sent to sign in a
second time to change members; creating an organization renews one on no
organization yet. What can go wrong is answered in the
directory's terms (`organization_directory.py`), so the route says it as it
says any other directory failure: a sign-in that has ended, or one WorkOS
won't renew for the organization as it stands, is `DirectorySignInRequired`,
which sends the admin through the sign-in again; a refusal is
`DirectoryRefusal`; WorkOS out of reach is `DirectoryUnavailable`.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, Request

from switch_core.db.models import User
from switch_core.gateway.auth import (
    AuthenticatedCaller,
    get_authenticated_caller,
    get_current_user,
    session_identity,
)
from switch_core.gateway.dependencies import get_identity_sessions
from switch_core.gateway.identity_sessions import (
    IdentitySessions,
    OrganizationSignInRequired,
    SignInEnded,
)
from switch_core.organization_directory import (
    AdminToken,
    CreatorToken,
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
)
from switch_core.workos_authkit import AuthKitRefused, AuthKitUnavailable

logger = logging.getLogger(__name__)

CHANGING_MEMBERS = "change the organization's members"
CREATING_AN_ORGANIZATION = "create an organization"

NOT_THROUGH_WORKOS = "Your sign-in can't {doing}. Sign in again to do it."
SIGN_IN_ENDED = "Your sign-in has ended. Sign in again to {doing}."
SIGN_IN_AGAIN = "Sign in again to {doing}: your account asks for it."
REFUSED = "Your account won't let you {doing} as you're signed in now."
UNREACHABLE = "Your account could not be reached to {doing}."


async def _renew(
    identity_sessions: IdentitySessions,
    user_id: str,
    identity_session: str | None,
    workos_organization_id: str | None,
    doing: str,
) -> str:
    """The person's token from `IdentitySessions.organization_token`, its
    failures said in the directory's terms, for `doing`."""
    if identity_session is None:
        raise DirectorySignInRequired(NOT_THROUGH_WORKOS.format(doing=doing))
    try:
        return await identity_sessions.organization_token(
            user_id, identity_session, workos_organization_id
        )
    except SignInEnded as error:
        raise DirectorySignInRequired(SIGN_IN_ENDED.format(doing=doing)) from error
    except OrganizationSignInRequired as error:
        raise DirectorySignInRequired(SIGN_IN_AGAIN.format(doing=doing)) from error
    except AuthKitRefused as error:
        logger.warning(
            "WorkOS refused to renew user %s's access for %s (%s): %s",
            user_id,
            workos_organization_id or "no organization",
            error.code,
            error.message,
        )
        raise DirectoryRefusal(REFUSED.format(doing=doing)) from error
    except AuthKitUnavailable as error:
        logger.warning(
            "Could not renew user %s's access for %s: %s",
            user_id,
            workos_organization_id or "no organization",
            error.message,
        )
        raise DirectoryUnavailable(UNREACHABLE.format(doing=doing)) from error


def signed_in_admin_token(
    request: Request,
    identity_sessions: Annotated[IdentitySessions, Depends(get_identity_sessions)],
    user: Annotated[User, Depends(get_current_user)],
) -> AdminToken:
    """What gets the signed-in admin's token for a WorkOS organization, from
    the identity session the request's cookie stands on, when a change asks
    for it."""
    identity_session = session_identity(request)

    async def renew(workos_organization_id: str) -> str:
        return await _renew(
            identity_sessions,
            user.id,
            identity_session,
            workos_organization_id,
            CHANGING_MEMBERS,
        )

    return renew


def signed_in_creator_token(
    request: Request,
    identity_sessions: Annotated[IdentitySessions, Depends(get_identity_sessions)],
    caller: Annotated[AuthenticatedCaller, Depends(get_authenticated_caller)],
) -> CreatorToken:
    """What gets the signed-in person's token on no organization yet, for
    creating one, when the directory asks for it."""
    identity_session = session_identity(request)

    async def renew() -> str:
        return await _renew(
            identity_sessions,
            caller.id,
            identity_session,
            None,
            CREATING_AN_ORGANIZATION,
        )

    return renew
