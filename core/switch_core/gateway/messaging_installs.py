"""Starting an install: the authenticated leg, and the only one that picks a tenant.

The endpoint answers with a URL rather than a redirect. The install has to
begin in a top-level browser window on the platform's own domain, and a
redirect from an XHR the operator's dashboard made would be followed by the
XHR, not by the window. Handing the URL back and letting the page navigate is
the shape that works.

**Who may act depends on how the platform installs.** An OAuth install creates
a connection, and connections are a tenant admin's. A claim-based platform
(Telegram) shares one connection per organisation across every chat claimed, so
one chat is a room: an admin connects the first, which turns the platform on,
and after that members connect chats, and see and disconnect the ones whose
room they may read and write — every chat, until someone makes its room
private. Turning it off again is deleting that connection, which is an
admin's. Every check for an OAuth
platform is the tenant-admin check `require_tenant_admin` makes, read here as
`get_tenant_is_admin` so a route that serves both kinds of platform can tell
them apart.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import Action, Principal, can
from switch_core.bridges.collaboration.install import MessagingInstallError
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import MessagingInstall, Room, User, require_tenant_id
from switch_core.db.stores.messaging_install_store import MessagingInstallNotFound
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import get_install_service, get_session

logger = logging.getLogger(__name__)

router = APIRouter()


class InstallStart(BaseModel):
    authorize_url: str


class ClaimablePlatform(BaseModel):
    """A claim-based platform, and what this caller may do with it.

    Computed here because the split between an admin's action and a member's
    depends on whether the organisation has a connection yet.
    """

    platform: str
    # The organisation already has a connection, so a chat is a room.
    connected: bool
    can_add_chat: bool


class InstallablePlatforms(BaseModel):
    # OAuth platforms, offered to a tenant admin only.
    platforms: list[str]
    claimable: list[ClaimablePlatform]


class ClaimStart(BaseModel):
    """A link that adds the bot to a group and claims it, its bare code, and
    the bot's handle for adding it to a channel by hand."""

    url: str
    code: str
    bot_handle: str


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
    # What a person calls it — a chat's room, or the workspace an OAuth
    # install came from — while it still has one. An ended install is shown by
    # its id.
    name: str | None
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


def _require_tenant_admin(is_admin: bool) -> None:
    if not is_admin:
        raise HTTPException(status_code=403, detail="Tenant admin access required")


def _by_claim(service: MessagingInstallService, platform: str) -> bool:
    try:
        return service.installer(platform).installs_by_claim
    except MessagingInstallError as failure:
        raise HTTPException(status_code=404, detail=str(failure)) from failure


@router.get("")
async def installable_platforms(
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> InstallablePlatforms:
    if service is None:
        return InstallablePlatforms(platforms=[], claimable=[])
    oauth = [p for p in service.platforms() if not _by_claim(service, p)]
    claimable = []
    for platform in service.platforms():
        if not _by_claim(service, platform):
            continue
        connected = await service.platform_connected(session, platform=platform)
        claimable.append(
            ClaimablePlatform(
                platform=platform,
                connected=connected,
                can_add_chat=connected or is_admin,
            )
        )
    return InstallablePlatforms(
        platforms=oauth if is_admin else [], claimable=claimable
    )


@router.post("/{platform}/claim")
async def begin_claim(
    platform: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> ClaimStart:
    """A link that connects a chat by adding the bot to it, and its code.

    Checked here as well as when the claim is redeemed, so a member told they
    cannot turn the platform on hears it now rather than from the bot. The
    redemption check is the one that holds: whether a connection exists can
    change in the ten minutes between the two.
    """
    installs = _require_installs(service)
    if not _by_claim(installs, platform):
        raise HTTPException(
            status_code=404, detail=f"{platform} is not installed by claiming a chat"
        )
    if not is_admin and not await installs.platform_connected(
        session, platform=platform
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Connecting the first {platform} chat turns {platform} on for "
                "this organisation, which only an admin can do."
            ),
        )
    try:
        link = await installs.begin_claim(session, platform=platform, user_id=user.id)
    except MessagingInstallError as failure:
        # The shared bot has not connected yet, so there is no link to offer.
        raise HTTPException(status_code=503, detail=str(failure)) from failure
    await record_audit_event(
        session,
        tenant_id=require_tenant_id(),
        actor_user_id=user.id,
        action=AuditAction.MESSAGING_INSTALL_STARTED,
        target_type="messaging_install",
        target_id=None,
        details={"platform": platform},
    )
    await session.commit()
    logger.info("Started a %s claim for user %s", platform, user.id)
    return ClaimStart(url=link.url, code=link.code, bot_handle=link.bot_handle)


@router.post("/{platform}/install")
async def begin_install(
    platform: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> InstallStart:
    _require_tenant_admin(is_admin)
    try:
        authorize_url = await _require_installs(service).begin(
            session, platform=platform, user_id=user.id
        )
    except MessagingInstallError as failure:
        raise HTTPException(status_code=404, detail=str(failure)) from failure

    await record_audit_event(
        session,
        tenant_id=require_tenant_id(),
        actor_user_id=user.id,
        action=AuditAction.MESSAGING_INSTALL_STARTED,
        target_type="messaging_install",
        target_id=None,
        details={"platform": platform},
    )
    await session.commit()
    logger.info("Started a %s install for user %s", platform, user.id)
    return InstallStart(authorize_url=authorize_url)


@router.get("/installs")
async def list_installs(
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> InstalledApps:
    """This organisation's installs, ended ones included.

    An empty list when the deployment registered no app of its own, rather
    than the 501 the install endpoints answer with: a deployment can have
    installs recorded from before its credentials were removed, and a page
    that cannot even show them is worse than one with nothing on it.
    """
    if service is None:
        return InstalledApps(installs=[])
    # A member sees the chats of claim-based platforms, which are rooms, and
    # not the OAuth workspaces, which are an admin's. Only the chats whose room
    # they may read: a private room's chat would otherwise name it to them.
    names = await service.install_names(session)
    rooms = await service.chat_rooms(session)
    principal = Principal(user.id, is_admin)
    return InstalledApps(
        installs=[
            _installed(install, names.get(install.id))
            for install in await service.list_installs(session)
            if is_admin
            or (
                _installs_by_claim_or_gone(service, install.platform)
                and _room_allows(principal, "read", rooms.get(install.id))
            )
        ]
    )


def _room_allows(principal: Principal, action: Action, room: Room | None) -> bool:
    """Whether a chat's room lets `principal` act on it; a chat with no room
    left (an ended one) has nothing private to show."""
    return room is None or can(principal, action, room)


def _installed(install: MessagingInstall, name: str | None) -> InstalledApp:
    return InstalledApp(
        id=install.id,
        platform=install.platform,
        external_workspace_id=install.external_workspace_id,
        name=name,
        status=install.status,
        scopes=install.scopes,
        bridge_id=install.bridge_id,
        installed_at=install.installed_at,
        ended_at=install.ended_at,
    )


def _installs_by_claim_or_gone(service: MessagingInstallService, platform: str) -> bool:
    """Whether a platform is claim-based; False once its installer is gone."""
    try:
        return service.installer(platform).installs_by_claim
    except MessagingInstallError:
        return False


@router.delete("/installs/{install_id}")
async def disconnect_install(
    install_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    service: Annotated[MessagingInstallService | None, Depends(get_install_service)],
    user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> InstalledApp:
    """End an install: revoke the credential, remove the bridge, free the workspace.

    Not on the request's session, deliberately. Disconnecting revokes a token
    at the platform and tears a bridge down, and holding this request's
    transaction open across both would keep a row locked while somebody else's
    API is slow. The service opens what it needs, in the order failure can be
    recovered from. The request's session is used only afterwards, to record
    the disconnect in the audit log.

    **Rooms that used the bridge become internal-only**, which is why this is a
    delete an admin has to ask for rather than anything inferred. One chat
    of a claim-based platform is a room, and whoever may write to that room
    may disconnect it, the same as moving the room onto another bridge.
    """
    installs = _require_installs(service)
    try:
        platform = await installs.install_platform(session, install_id=install_id)
    except MessagingInstallNotFound as missing:
        raise HTTPException(status_code=404, detail=str(missing)) from missing
    if not _installs_by_claim_or_gone(installs, platform):
        _require_tenant_admin(is_admin)
    else:
        room = (await installs.chat_rooms(session)).get(install_id)
        if room is None:
            # Nobody's room covers it any more, so it is the tenant's to decide.
            if not is_admin:
                raise HTTPException(
                    status_code=403,
                    detail="Only an admin can disconnect a chat whose room is gone.",
                )
        elif not can(Principal(user.id, is_admin), "write", room):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Only someone who can change this chat's room in Switch, its "
                    "owner or an admin, can disconnect it."
                ),
            )
    try:
        ended = await installs.disconnect(
            tenant_id=require_tenant_id(), install_id=install_id
        )
    except MessagingInstallNotFound as missing:
        raise HTTPException(status_code=404, detail=str(missing)) from missing
    except MessagingInstallError as failure:
        # The platform refused to revoke and nothing was destroyed, so this is
        # upstream's answer rather than a fault here — and it is retryable,
        # which the operator needs to be told rather than left to guess.
        raise HTTPException(status_code=502, detail=str(failure)) from failure

    await record_audit_event(
        session,
        tenant_id=ended.tenant_id,
        actor_user_id=user.id,
        action=AuditAction.MESSAGING_INSTALL_DISCONNECTED,
        target_type="messaging_install",
        target_id=install_id,
        details={
            "platform": ended.platform,
            "external_workspace_id": ended.external_workspace_id,
        },
    )
    await session.commit()
    logger.info("User %s disconnected messaging install %s", user.id, install_id)
    # Ended, so it has let go of whatever it was called.
    return _installed(ended, None)
