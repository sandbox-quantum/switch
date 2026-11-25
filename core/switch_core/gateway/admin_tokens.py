"""The signed-in admin's own access to their organization's account, for the
changes its account service takes only from them (`members_service.py`).

An admin signs in once, through WorkOS AuthKit, and that sign-in's refresh
token is kept with the identity session their cookie stands on
(`gateway/identity_sessions.py`). When a change needs the admin's token for
the organization, it is renewed from there for that organization alone
(`IdentitySessions.organization_token`), so nobody is sent to sign in a
second time to change members. What can go wrong is answered in the
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
from switch_core.gateway.auth import get_current_user, session_identity
from switch_core.gateway.dependencies import get_identity_sessions
from switch_core.gateway.identity_sessions import (
    IdentitySessions,
    OrganizationSignInRequired,
    SignInEnded,
)
from switch_core.organization_directory import (
    AdminToken,
    DirectoryRefusal,
    DirectorySignInRequired,
    DirectoryUnavailable,
)
from switch_core.workos_authkit import AuthKitRefused, AuthKitUnavailable

logger = logging.getLogger(__name__)

NOT_THROUGH_WORKOS = (
    "You didn't sign in through your organization's account. Sign in through "
    "it to change the organization's members."
)
SIGN_IN_ENDED = (
    "Your sign-in has ended. Sign in again to change the organization's members."
)
SIGN_IN_AGAIN = (
    "Your organization's account needs you to sign in again before you change "
    "its members."
)
REFUSED = (
    "Your organization's account won't let you change its members as you're "
    "signed in now."
)
UNREACHABLE = "Your organization's account could not be reached."


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
        if identity_session is None:
            raise DirectorySignInRequired(NOT_THROUGH_WORKOS)
        try:
            return await identity_sessions.organization_token(
                user.id, identity_session, workos_organization_id
            )
        except SignInEnded as error:
            raise DirectorySignInRequired(SIGN_IN_ENDED) from error
        except OrganizationSignInRequired as error:
            raise DirectorySignInRequired(SIGN_IN_AGAIN) from error
        except AuthKitRefused as error:
            logger.warning(
                "WorkOS refused to renew user %s's access for organization %s (%s): %s",
                user.id,
                workos_organization_id,
                error.code,
                error.message,
            )
            raise DirectoryRefusal(REFUSED) from error
        except AuthKitUnavailable as error:
            logger.warning(
                "Could not renew user %s's access for organization %s: %s",
                user.id,
                workos_organization_id,
                error.message,
            )
            raise DirectoryUnavailable(UNREACHABLE) from error

    return renew
