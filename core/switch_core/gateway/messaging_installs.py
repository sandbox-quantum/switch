"""Starting an install: the authenticated leg, and the only one that picks a tenant.

The endpoint answers with a URL rather than a redirect. The install has to
begin in a top-level browser window on the platform's own domain, and a
redirect from an XHR the operator's dashboard made would be followed by the
XHR, not by the window. Handing the URL back and letting the page navigate is
the shape that works.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.collaboration.install import MessagingInstallError
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.db.models import User
from switch_core.gateway.auth import require_admin
from switch_core.gateway.dependencies import get_install_service, get_session

logger = logging.getLogger(__name__)

router = APIRouter()


class InstallStart(BaseModel):
    authorize_url: str


class InstallablePlatforms(BaseModel):
    platforms: list[str]


def _require_installs(
    service: MessagingInstallService | None,
) -> MessagingInstallService:
    """Refuse rather than pretend when this deployment registered no app.

    Most deployments will register none — the self-hosted path is an operator
    registering their own app and pasting the token in — so this is an ordinary
    answer and not an error condition. It is still a refusal: a deployment that
    offered the button and then failed at the platform would be worse.
    """
    if service is None:
        raise HTTPException(
            status_code=501,
            detail=(
                "This Switch deployment has no messaging app of its own to "
                "install. Register a bridge with your own app's credentials "
                "instead."
            ),
        )
    return service


@router.get("")
async def installable_platforms(
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    _user: Annotated[User, Depends(require_admin)],
) -> InstallablePlatforms:
    return InstallablePlatforms(
        platforms=[] if service is None else service.platforms()
    )


@router.post("/{platform}/install")
async def begin_install(
    platform: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    user: Annotated[User, Depends(require_admin)],
) -> InstallStart:
    try:
        authorize_url = await _require_installs(service).begin(
            session, platform=platform, user_id=user.id
        )
    except MessagingInstallError as failure:
        raise HTTPException(status_code=404, detail=str(failure)) from failure

    await session.commit()
    logger.info("Started a %s install for user %s", platform, user.id)
    return InstallStart(authorize_url=authorize_url)
