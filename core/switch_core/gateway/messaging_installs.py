"""Starting an install: the authenticated leg, and the only one that picks a tenant.

The endpoint answers with a URL rather than a redirect. The install has to
begin in a top-level browser window on the platform's own domain, and a
redirect from an XHR the operator's dashboard made would be followed by the
XHR, not by the window. Handing the URL back and letting the page navigate is
the shape that works.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.collaboration.install import MessagingInstallError
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.db.models import User, require_tenant_id
from switch_core.db.stores.messaging_install_store import MessagingInstallNotFound
from switch_core.gateway.auth import require_admin
from switch_core.gateway.dependencies import get_install_service, get_session

logger = logging.getLogger(__name__)

router = APIRouter()


class InstallStart(BaseModel):
    authorize_url: str


class InstallablePlatforms(BaseModel):
    platforms: list[str]


class InstalledApp(BaseModel):
    """One install as an operator needs to see it.

    No token and nothing derived from one. `status` and `ended_at` are the
    point of the shape rather than decoration: an operator looks at this list
    because a bridge stopped working, and "disconnected" and "revoked" are the
    difference between a decision someone here made and news from the
    platform.
    """

    id: str
    platform: str
    external_workspace_id: str
    status: str
    scopes: str
    bridge_id: str | None
    installed_at: datetime
    ended_at: datetime | None


class InstalledApps(BaseModel):
    installs: list[InstalledApp]


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


@router.get("/installs")
async def list_installs(
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    _user: Annotated[User, Depends(require_admin)],
) -> InstalledApps:
    """This organisation's installs, ended ones included.

    An empty list when the deployment registered no app of its own, rather
    than the 501 the install endpoints answer with: a deployment can have
    installs recorded from before its credentials were removed, and a page
    that cannot even show them is worse than one with nothing on it.
    """
    if service is None:
        return InstalledApps(installs=[])
    return InstalledApps(
        installs=[
            InstalledApp.model_validate(install, from_attributes=True)
            for install in await service.list_installs(session)
        ]
    )


@router.delete("/installs/{install_id}")
async def disconnect_install(
    install_id: str,
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    user: Annotated[User, Depends(require_admin)],
) -> InstalledApp:
    """End an install: revoke the credential, remove the bridge, free the workspace.

    Not on the request's session, deliberately. Disconnecting revokes a token
    at the platform and tears a bridge down, and holding this request's
    transaction open across both would keep a row locked while somebody else's
    API is slow. The service opens what it needs, in the order failure can be
    recovered from.

    **Rooms that used the bridge become internal-only**, which is why this is a
    delete an operator has to ask for rather than anything inferred.
    """
    try:
        ended = await _require_installs(service).disconnect(
            tenant_id=require_tenant_id(), install_id=install_id
        )
    except MessagingInstallNotFound as missing:
        raise HTTPException(status_code=404, detail=str(missing)) from missing
    except MessagingInstallError as failure:
        # The platform refused to revoke and nothing was destroyed, so this is
        # upstream's answer rather than a fault here — and it is retryable,
        # which the operator needs to be told rather than left to guess.
        raise HTTPException(status_code=502, detail=str(failure)) from failure

    logger.info("User %s disconnected messaging install %s", user.id, install_id)
    return InstalledApp.model_validate(ended, from_attributes=True)
