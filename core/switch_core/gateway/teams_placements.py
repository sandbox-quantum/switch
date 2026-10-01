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
    has_switch: bool
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
    adapter = collab_lifecycle.get_adapter(bridge_id)
    if not isinstance(adapter, TeamsAdapter):
        raise HTTPException(
            status_code=409,
            detail="The Teams connection is not running; try again in a moment.",
        )
    return adapter, install


def _catalog_app_id(install: MessagingInstall) -> str | None:
    value = install.platform_data.get("catalog_app_id")
    return str(value) if value else None


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
    except BridgeOperationError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    default = adapter.default_team_id
    catalog_app_id = _catalog_app_id(install)
    problem = install.platform_data.get("publish_problem")
    return TeamPlacements(
        teams=[
            TeamPlacementOut(
                team_id=p.team_id,
                name=p.name,
                has_switch=p.has_switch,
                is_default=p.team_id == default,
            )
            for p in placements
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
    if catalog_app_id is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Switch is not in your organisation's Teams app list yet, so it "
                "cannot add itself to a team. Ask a Teams admin to upload the app "
                "package, or approve Switch again as a Teams admin."
            ),
        )
    try:
        await adapter.add_to_team(team_id, catalog_app_id=catalog_app_id)
    except BridgeOperationError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
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
    except BridgeOperationError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
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
