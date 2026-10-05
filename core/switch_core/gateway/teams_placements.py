"""Which teams the distributed Teams app is in, from Switch.

A Microsoft admin approves the app for the whole organisation, and Switch adds
it to the organisation's app catalogue; which teams it then joins is chosen
here, on the connection, by the workspace's own admins. The team new channels
go in — the connection's default team — is an ordinary edit of the connection
(`PATCH /collaborations/{id}`), the one setting of a shared Teams bridge that
is anyone's to change.

Everything here is refused for a connection that is not on the distributed
app: a bring-your-own app is added to teams in Teams, by whoever owns it.
"""

from __future__ import annotations

import logging
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.collaboration.install import MessagingInstallError
from switch_core.bridges.collaboration.install_service import MessagingInstallService
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.teams.auth import TokenRequestRefused
from switch_core.bridges.collaboration.teams.install import TeamsAppInstaller
from switch_core.db.models import MessagingInstall, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.messaging_install_store import MessagingInstallStore
from switch_core.gateway.auth import require_tenant_admin
from switch_core.gateway.dependencies import (
    get_bridge_store,
    get_collab_lifecycle,
    get_install_service,
    get_install_store,
    get_session,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class TeamPlacementOut(BaseModel):
    team_id: str
    name: str
    # None when the team's apps could not be read (archived, being deleted,
    # restricted); the rest of the list is still answered.
    has_switch: bool | None
    is_default: bool


class TeamPlacements(BaseModel):
    teams: list[TeamPlacementOut]
    default_team_id: str | None
    # Whether the app is in the organisation's catalogue, which adding it to a
    # team needs. When it is not, `catalog_problem` says why, and the package
    # can be downloaded for a Teams admin to upload.
    in_catalog: bool
    catalog_problem: str | None


async def _connection(
    bridge_id: str,
    session: AsyncSession,
    bridge_store: CollaborationBridgeStore,
    install_store: MessagingInstallStore,
    collab_lifecycle: CollaborationBridgeLifecycleService,
) -> tuple[TeamsAdapter, MessagingInstall]:
    """The running shared Teams bridge and its install, if both are the caller's.

    The bridge is read on the caller's own scoped session, so another tenant's
    is simply not found.
    """
    bridge = await bridge_store.get(session, bridge_id)
    install = await install_store.get_for_bridge(session, bridge_id=bridge_id)
    if bridge is None or install is None or bridge.type != "teams":
        raise HTTPException(
            status_code=404,
            detail="No connection on the distributed Teams app has that id.",
        )
    # Connected, not merely registered: a bridge restarting — as it does after
    # its default team changes — is registered before it has a Graph client.
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if not isinstance(adapter, TeamsAdapter) or not collab_lifecycle.is_connected(
        bridge_id
    ):
        raise HTTPException(
            status_code=503,
            detail="The Teams connection is not running; try again in a moment.",
        )
    return adapter, install


def _catalog_app_id(install: MessagingInstall) -> str | None:
    value = install.platform_data.get("catalog_app_id")
    return str(value) if value else None


#: What Microsoft can answer a placement request with that is its refusal or
#: its absence rather than a fault here: shown to the admin, never a 500.
_MICROSOFT_FAILURES = (BridgeOperationError, TokenRequestRefused, httpx.HTTPError)


def _microsoft_failed(error: Exception) -> HTTPException:
    return HTTPException(status_code=502, detail=f"Microsoft refused: {error}")


async def _learn_catalog_app_id(
    session: AsyncSession,
    install_store: MessagingInstallStore,
    install: MessagingInstall,
    seen: str | None,
) -> str | None:
    """The app's catalogue id, recording it if an installation just revealed it.

    Switch learns the id when it publishes the app itself. When a Teams admin
    uploaded the package by hand instead, the first team the app is added to
    — from Teams — reports it, and from then on Switch can add the app to the
    rest.
    """
    known = _catalog_app_id(install)
    if known is not None or seen is None:
        return known
    await install_store.remember(
        session,
        install_id=install.id,
        platform_data={"catalog_app_id": seen, "publish_problem": None},
    )
    await session.commit()
    return seen


@router.get("/{bridge_id}/teams")
async def list_team_placements(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    install_store: Annotated[MessagingInstallStore, Depends(get_install_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> TeamPlacements:
    adapter, install = await _connection(
        bridge_id, session, bridge_store, install_store, collab_lifecycle
    )
    try:
        placements = await adapter.list_team_placements()
    except _MICROSOFT_FAILURES as error:
        raise _microsoft_failed(error) from error
    catalog_app_id = await _learn_catalog_app_id(
        session, install_store, install, placements.catalog_app_id
    )
    default = adapter.default_team_id
    problem = install.platform_data.get("publish_problem")
    return TeamPlacements(
        teams=[
            TeamPlacementOut(
                team_id=p.team_id,
                name=p.name,
                has_switch=p.has_switch,
                is_default=p.team_id == default,
            )
            for p in placements.teams
        ],
        default_team_id=default,
        in_catalog=catalog_app_id is not None,
        catalog_problem=str(problem) if problem and catalog_app_id is None else None,
    )


@router.post("/{bridge_id}/teams/{team_id}", status_code=204)
async def add_to_team(
    bridge_id: str,
    team_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    install_store: Annotated[MessagingInstallStore, Depends(get_install_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> Response:
    adapter, install = await _connection(
        bridge_id, session, bridge_store, install_store, collab_lifecycle
    )
    catalog_app_id = _catalog_app_id(install)
    try:
        if catalog_app_id is None:
            placements = await adapter.list_team_placements()
            catalog_app_id = await _learn_catalog_app_id(
                session, install_store, install, placements.catalog_app_id
            )
        if catalog_app_id is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Switch cannot add itself to a team until it knows where the "
                    "app is in your organisation's Teams app list. Once a Teams "
                    "admin has uploaded it, add it to any one team from Teams "
                    "(Apps, Built for your org, Agent Switch) and Switch can add "
                    "it to the rest; or have a Global Administrator approve "
                    "Switch again, so Switch puts it in the list itself."
                ),
            )
        await adapter.add_to_team(team_id, catalog_app_id=catalog_app_id)
    except _MICROSOFT_FAILURES as error:
        raise _microsoft_failed(error) from error
    return Response(status_code=204)


@router.delete("/{bridge_id}/teams/{team_id}", status_code=204)
async def remove_from_team(
    bridge_id: str,
    team_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    install_store: Annotated[MessagingInstallStore, Depends(get_install_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> Response:
    adapter, _install = await _connection(
        bridge_id, session, bridge_store, install_store, collab_lifecycle
    )
    try:
        await adapter.remove_from_team(team_id)
    except _MICROSOFT_FAILURES as error:
        raise _microsoft_failed(error) from error
    if adapter.default_team_id == team_id:
        # New channels are made in the default team, and cannot be in one the
        # app has left: channel creation goes off with the default, until
        # another team is chosen, rather than failing at the next room.
        await bridge_store.merge_connection_config(
            session, bridge_id, {"team_id": None}
        )
        await bridge_store.set_channel_creation_enabled(session, bridge_id, False)
        await session.commit()
        await collab_lifecycle.restart(bridge_id)
    return Response(status_code=204)


@router.get("/{bridge_id}/teams-package")
async def download_app_package(
    bridge_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    bridge_store: Annotated[CollaborationBridgeStore, Depends(get_bridge_store)],
    install_store: Annotated[MessagingInstallStore, Depends(get_install_store)],
    collab_lifecycle: Annotated[
        CollaborationBridgeLifecycleService, Depends(get_collab_lifecycle)
    ],
    install_service: Annotated[
        MessagingInstallService | None, Depends(get_install_service)
    ],
    _user: Annotated[User, Depends(require_tenant_admin)],
) -> Response:
    """The app package, for a Teams admin to upload where Switch could not."""
    await _connection(bridge_id, session, bridge_store, install_store, collab_lifecycle)
    try:
        installer = (
            install_service.installer("teams") if install_service is not None else None
        )
    except MessagingInstallError:
        installer = None
    if not isinstance(installer, TeamsAppInstaller):
        raise HTTPException(
            status_code=404,
            detail="This deployment has no distributed Teams app.",
        )
    return Response(
        content=installer.package.archive,
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="switch-teams-{installer.package.version}.zip"'
            )
        },
    )
