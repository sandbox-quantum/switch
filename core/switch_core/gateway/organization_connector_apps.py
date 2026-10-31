"""An organization's admins set up the apps its workspaces sign in through.

The organization's counterpart of `gateway/connector_apps.py`, sharing its
entry shape (`entry_body`) and everything a save asks before it is stored
(`checked_save`): the vendor checks a save first, no response carries a
secret, and a different app is taken only when asked for on purpose.
`org_admin` only, acting on the bound workspace's organization; the
platform operator has no say here unless they are one.

Which app a workspace then uses is `connections/organization_apps.py`: the
organization's where it saved one, else the server's. So an organization's
page shows, beside each of its own apps, whether the server's would serve
its workspaces meanwhile (`server_app`). There is nothing to import:
configuration is the server's alone.

Mounted only with both `service_connections` and
`organization_connector_apps` on. A save or removal takes effect at once in
every process (`OrganizationApps.changed`), and is recorded in the
organization's audit log.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.app_credentials import (
    AppLoadError,
    AppSpec,
    AppValues,
    ConnectorApps,
    UnreadableAppError,
    load_saved_app,
)
from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import User
from switch_core.db.stores.app_secrets import MissingSecretsError
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, organization_workspace_ids
from switch_core.gateway.connector_apps import (
    SaveApp,
    SavedApp,
    StoredApp,
    Usage,
    Usages,
    app_spec,
    check_values,
    checked_save,
    checks_body,
    entry_body,
    get_connector_apps,
    refuse_while_blocked,
    saved_app,
    saved_app_redirects,
    usages_in,
)
from switch_core.gateway.dependencies import (
    get_organization_store,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.organizations import require_organization_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/organizations/current/connector-apps")


def get_organization_apps(request: Request) -> OrganizationApps:
    apps = getattr(request.app.state, "organization_apps", None)
    if not isinstance(apps, OrganizationApps):
        raise RuntimeError("No organizations' apps are installed on this app.")
    return cast(OrganizationApps, apps)


def get_organization_app_store(
    organization_apps: Annotated[OrganizationApps, Depends(get_organization_apps)],
) -> OrganizationAppCredentialStore:
    return organization_apps.store


async def _admin_of(
    session: AsyncSession,
    user_store: UserStore,
    organization_store: OrganizationStore,
    user: User,
) -> str:
    """The bound workspace's organization, which `user` must administer."""
    access = await require_organization_admin(
        session, user_store, organization_store, user, operator_restores=False
    )
    return access.organization_id


async def _usages(
    session_factory: async_sessionmaker[AsyncSession],
    user: User,
    organization_id: str,
) -> Usages:
    """Every connection in the organization's workspaces. The caller's
    session has let its connection go: this opens one per workspace."""
    return await usages_in(
        session_factory,
        await organization_workspace_ids(session_factory, user.id, organization_id),
        leave_out_organization_apps=False,
    )


@dataclass(frozen=True)
class _OrganizationApp:
    """What the organization saved for a service, read through the request's
    session before its connection is let go for the usage scan."""

    saved: SavedApp | None
    values: AppValues | None
    load_error: str | None
    unreadable: bool

    @property
    def current(self) -> str | None:
        """The client its workspaces go through, if the app can be used."""
        if self.saved is None or self.load_error is not None:
            return None
        return self.saved.client_id


async def _read(
    session: AsyncSession,
    apps: ConnectorApps,
    store: OrganizationAppCredentialStore,
    organization_id: str,
    spec: AppSpec,
) -> _OrganizationApp:
    row = await store.get(session, organization_id, spec.service)
    if row is None:
        return _OrganizationApp(None, None, None, False)
    values: AppValues | None = None
    load_error: str | None = None
    unreadable = False
    try:
        values = load_saved_app(
            spec,
            client_id=row.client_id,
            settings=row.settings,
            secrets=lambda: store.secrets(row),
            public_url=apps.public_url,
        ).values
    except UnreadableAppError as error:
        load_error, unreadable = str(error), True
    except AppLoadError as error:
        load_error = str(error)
    return _OrganizationApp(
        saved=await saved_app(session, row),
        values=values,
        load_error=load_error,
        unreadable=unreadable,
    )


def _entry(
    apps: ConnectorApps,
    spec: AppSpec,
    read: _OrganizationApp,
    usage: Usage,
    server_serves: bool,
) -> dict[str, Any]:
    return {
        **entry_body(
            apps,
            spec,
            source="saved" if read.current is not None else "none",
            configuration_variables=[],
            deprecated=False,
            current=read.current,
            saved=read.saved,
            shown=read.values,
            saved_ignored=False,
            unreadable=read.unreadable,
            load_error=read.load_error,
            redirects=saved_app_redirects(apps, spec),
            usage=usage,
        ),
        # Whether the server's app serves the organization's workspaces while
        # it saves none of its own.
        "server_app": server_serves,
    }


async def _one_entry(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    apps: ConnectorApps,
    store: OrganizationAppCredentialStore,
    broker: ServiceBroker,
    user: User,
    organization_id: str,
    spec: AppSpec,
) -> dict[str, Any]:
    read = await _read(session, apps, store, organization_id, spec)
    await session.commit()
    usages = await _usages(session_factory, user, organization_id)
    return _entry(
        apps, spec, read, usages.of(spec.service), broker.server_serves(spec.service)
    )


@router.get("")
async def list_organization_connector_apps(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    store: Annotated[
        OrganizationAppCredentialStore, Depends(get_organization_app_store)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any]:
    organization_id = await _admin_of(session, user_store, organization_store, user)
    reads = [
        (spec, await _read(session, apps, store, organization_id, spec))
        for spec in apps.specs.values()
    ]
    # The request's connection goes back before the scan opens one per workspace.
    await session.commit()
    usages = await _usages(session_factory, user, organization_id)
    return {
        "public_url": apps.public_url,
        "apps": [
            _entry(
                apps,
                spec,
                read,
                usages.of(spec.service),
                broker.server_serves(spec.service),
            )
            for spec, read in reads
        ],
    }


@router.put("/{service}", response_model=None)
async def save_organization_connector_app(
    service: str,
    body: SaveApp,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    organization_apps: Annotated[OrganizationApps, Depends(get_organization_apps)],
    store: Annotated[
        OrganizationAppCredentialStore, Depends(get_organization_app_store)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any] | JSONResponse:
    organization_id = await _admin_of(session, user_store, organization_store, user)
    spec = app_spec(apps, service)
    refuse_while_blocked(spec, apps.public_url)
    row = await store.get(session, organization_id, service)
    checked = await checked_save(
        apps,
        spec,
        body,
        None
        if row is None
        else StoredApp(row.client_id, row.settings, lambda: store.secrets(row)),
        saved_app_redirects(apps, spec),
    )
    if isinstance(checked, JSONResponse):
        return checked
    try:
        await store.save(
            session,
            organization_id=organization_id,
            service=service,
            client_id=body.client_id,
            settings=checked.result.settings,
            secrets=checked.given,
            secret_names=spec.secret_names,
            updated_by=user.id,
        )
    except MissingSecretsError as error:
        raise HTTPException(422, str(error)) from None
    details = checked.details(service, body.client_id)
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.CONNECTOR_APP_SAVED,
        target_type="service",
        target_id=service,
        details=details,
    )
    await session.commit()
    organization_apps.changed(organization_id, service)
    logger.warning(
        "An organization admin saved %s's app: organization=%s user=%s fields=%s",
        spec.name,
        organization_id,
        user.id,
        details["fields_changed"],
    )
    return {
        **await _one_entry(
            session,
            session_factory,
            apps,
            store,
            broker,
            user,
            organization_id,
            spec,
        ),
        "checks": checks_body(checked.result),
    }


@router.post("/{service}/check")
async def check_organization_connector_app(
    service: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    store: Annotated[
        OrganizationAppCredentialStore, Depends(get_organization_app_store)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any]:
    """Ask the vendor about the organization's app; nothing is stored."""
    organization_id = await _admin_of(session, user_store, organization_store, user)
    spec = app_spec(apps, service)
    refuse_while_blocked(spec, apps.public_url)
    read = await _read(session, apps, store, organization_id, spec)
    await session.commit()
    if read.saved is None:
        raise HTTPException(409, f"Your organization has no {spec.name} app to check.")
    if read.values is None:
        raise HTTPException(
            409, read.load_error or f"{spec.name}'s app cannot be read."
        )
    result = await check_values(
        apps, spec, read.values, saved_app_redirects(apps, spec)
    )
    return {"ok": result.ok, "checks": checks_body(result)}


@router.get("/{service}/impact")
async def organization_connector_app_impact(
    service: str,
    client_id: Annotated[str, Query(min_length=1, max_length=512)],
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    store: Annotated[
        OrganizationAppCredentialStore, Depends(get_organization_app_store)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, int]:
    """Who in the organization would have to reconnect if `client_id`
    became the app its workspaces use."""
    organization_id = await _admin_of(session, user_store, organization_store, user)
    app_spec(apps, service)
    row = await store.get(session, organization_id, service)
    if row is not None:
        current: str | None = row.client_id
    else:
        server = apps.effective(service).values
        current = None if server is None else server.client_id
    await session.commit()
    usage = (await _usages(session_factory, user, organization_id)).of(service)
    people, workspaces = usage.not_through(client_id, current)
    return {"connected_members": people, "workspaces": workspaces}


@router.delete("/{service}")
async def remove_organization_connector_app(
    service: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    organization_apps: Annotated[OrganizationApps, Depends(get_organization_apps)],
    store: Annotated[
        OrganizationAppCredentialStore, Depends(get_organization_app_store)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, int]:
    """Remove the organization's app. Its workspaces go back to the server's
    app, where the server has one; the connections made through the
    organization's are kept, and must reconnect before they are used."""
    organization_id = await _admin_of(session, user_store, organization_store, user)
    spec = app_spec(apps, service)
    removed = await store.remove(session, organization_id, service)
    if removed is None:
        raise HTTPException(404, f"Your organization has no saved {spec.name} app.")
    await record_organization_audit_event(
        session,
        organization_id=organization_id,
        actor_user_id=user.id,
        action=OrganizationAuditAction.CONNECTOR_APP_REMOVED,
        target_type="service",
        target_id=service,
        details={"service": service, "client_id": removed.client_id},
    )
    await session.commit()
    organization_apps.changed(organization_id, service)
    logger.warning(
        "An organization admin removed %s's app: organization=%s user=%s",
        spec.name,
        organization_id,
        user.id,
    )
    people, workspaces = (
        (await _usages(session_factory, user, organization_id))
        .of(service)
        .through(removed.client_id)
    )
    return {"connected_members": people, "workspaces": workspaces}
