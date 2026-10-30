"""An organization's admins set up the apps its workspaces sign in through.

The organization's counterpart of `gateway/connector_apps.py`, and the same
rules: a save is checked with the vendor first and stored only if the vendor
accepts it, no response carries a secret, and a different app is taken only
when asked for on purpose. `org_admin` only, acting on the bound
workspace's organization; the platform operator has no say here unless they
are one.

Which app a workspace then uses is `connections/organization_apps.py`: the
organization's where it saved one, else the server's. So an organization's
page shows, beside each of its own apps, whether the server offers one its
workspaces fall back to. There is nothing to import: configuration is the
server's alone.

Mounted only with both `service_connections` and
`organization_connector_apps` on. A save or removal takes effect at once in
every process (`OrganizationApps.changed`), and is recorded in the
organization's audit log.
"""

from __future__ import annotations

import logging
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
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import OrganizationAppCredential, User
from switch_core.db.stores.app_secrets import MissingSecretsError
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user, organization_workspace_ids
from switch_core.gateway.connector_apps import (
    SaveApp,
    Usage,
    app_scopes,
    app_spec,
    check_values,
    checks_body,
    fields_changed,
    get_connector_apps,
    needs_public_url,
    refuse_while_blocked,
    saved_app_redirects,
    secret_views,
    setup_blocked,
    usage_in,
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


async def _usage(
    session_factory: async_sessionmaker[AsyncSession],
    user: User,
    organization_id: str,
    service: str,
) -> Usage:
    """`service`'s connections in the organization's workspaces."""
    return await usage_in(
        session_factory,
        service,
        await organization_workspace_ids(session_factory, user.id, organization_id),
    )


def _opened(
    apps: ConnectorApps,
    store: OrganizationAppCredentialStore,
    spec: AppSpec,
    row: OrganizationAppCredential,
) -> tuple[AppValues | None, str | None, bool]:
    """The saved row's values, why it cannot be used, and whether no key
    opens it."""
    try:
        loaded = load_saved_app(
            spec,
            client_id=row.client_id,
            settings=row.settings,
            secrets=lambda: store.secrets(row),
            public_url=apps.public_url,
        )
    except UnreadableAppError as error:
        return None, str(error), True
    except AppLoadError as error:
        return None, str(error), False
    return loaded.values, None, False


async def _entry(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    apps: ConnectorApps,
    store: OrganizationAppCredentialStore,
    user: User,
    organization_id: str,
    spec: AppSpec,
) -> dict[str, Any]:
    """One service's app, in the shape of the operator's page
    (`connector_apps._entry`), and whether the server has one to fall back
    to."""
    row = await store.get(session, organization_id, spec.service)
    values, load_error, unreadable = (
        (None, None, False) if row is None else _opened(apps, store, spec, row)
    )
    in_use = row is not None and load_error is None
    current = row.client_id if in_use and row is not None else None
    usage = await _usage(session_factory, user, organization_id, spec.service)
    people, workspaces = usage.through(current) if current is not None else (0, 0)
    updated_by = None
    if row is not None and row.updated_by is not None:
        author = await session.get(User, row.updated_by)
        updated_by = None if author is None else author.name
    slug = None if row is None else row.settings.get("slug")
    redirects = saved_app_redirects(apps, spec)
    return {
        "slug": spec.service,
        "name": spec.name,
        "kind": spec.kind,
        "source": "saved" if in_use else "none",
        "configuration_variables": [],
        "deprecated": False,
        "client_id": None if row is None else row.client_id,
        "saved_client_id": None if row is None else row.client_id,
        "fields": {"slug": slug} if spec.kind == "github_app" else {},
        "secrets": secret_views(
            spec, None if values is None else values.secrets, row is not None
        ),
        "saved_ignored": False,
        "unreadable": unreadable,
        "load_error": load_error,
        "redirect_uri": next(iter(redirects), None),
        "redirect_uris": redirects,
        "needs_public_url": needs_public_url(apps, spec),
        "scopes": app_scopes(apps, spec),
        "setup_blocked": setup_blocked(spec, apps.public_url),
        "install_url": (
            f"https://github.com/apps/{slug}/installations/new"
            if spec.kind == "github_app" and slug
            else None
        ),
        "updated_by_name": updated_by,
        "updated_at": None if row is None else row.updated_at.isoformat(),
        "connected_members": people,
        "workspaces": workspaces,
        "stale_connections": usage.stale(current),
        # Whether the organization's workspaces use the server's app while it
        # saves none of its own.
        "server_app": apps.effective(spec.service).source != "none",
    }


@router.get("")
async def list_organization_connector_apps(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    store: Annotated[
        OrganizationAppCredentialStore, Depends(get_organization_app_store)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    organization_store: Annotated[OrganizationStore, Depends(get_organization_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> dict[str, Any]:
    organization_id = await _admin_of(session, user_store, organization_store, user)
    return {
        "public_url": apps.public_url,
        "apps": [
            await _entry(
                session, session_factory, apps, store, user, organization_id, spec
            )
            for spec in apps.specs.values()
        ],
    }


@router.put("/{service}", response_model=None)
async def save_organization_connector_app(
    service: str,
    body: SaveApp,
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
) -> dict[str, Any] | JSONResponse:
    organization_id = await _admin_of(session, user_store, organization_store, user)
    spec = app_spec(apps, service)
    refuse_while_blocked(spec, apps.public_url)
    given = {
        name: value
        for name, value in (
            ("client_secret", body.client_secret),
            ("private_key", body.private_key),
        )
        if value is not None
    }
    unknown = set(given) - spec.secret_names
    if unknown:
        raise HTTPException(422, f"{spec.name} has no {', '.join(sorted(unknown))}.")
    row = await store.get(session, organization_id, service)
    if row is not None and row.client_id != body.client_id and not body.replace:
        raise HTTPException(
            409,
            "This is a different app: everyone connected through the current one "
            "would have to reconnect. Use a different app to switch on purpose.",
        )
    previous: AppValues | None = None
    if row is not None:
        values, _, unreadable = _opened(apps, store, spec, row)
        if unreadable and not spec.secret_names <= set(given):
            raise HTTPException(
                422,
                "Switch can't read the saved secret any more. Enter every secret "
                "again.",
            )
        previous = values or (
            None
            if unreadable
            else AppValues(row.client_id, dict(row.settings), store.secrets(row))
        )
    # Another app's secrets are no use to this one: switching names them all.
    kept = (
        {}
        if previous is None or previous.client_id != body.client_id
        else previous.secrets
    )
    candidate_secrets = {**kept, **given}
    missing = spec.secret_names - set(candidate_secrets)
    if missing:
        names = " and ".join(name.replace("_", " ") for name in sorted(missing))
        raise HTTPException(422, f"Enter the {names}.")
    result = await check_values(
        apps,
        spec,
        AppValues(
            body.client_id,
            {} if previous is None else previous.settings,
            candidate_secrets,
        ),
        saved_app_redirects(apps, spec),
    )
    if not result.ok:
        failure = result.first_failure()
        assert failure is not None
        return JSONResponse(
            status_code=422,
            content={
                "detail": failure.message,
                "field": failure.field,
                "checks": checks_body(result),
            },
        )
    previous_client_id = None if row is None else row.client_id
    try:
        await store.save(
            session,
            organization_id=organization_id,
            service=service,
            client_id=body.client_id,
            settings=result.settings,
            secrets=given,
            secret_names=spec.secret_names,
            updated_by=user.id,
        )
    except MissingSecretsError as error:
        raise HTTPException(422, str(error)) from None
    details: dict[str, Any] = {
        "service": service,
        "fields_changed": fields_changed(
            previous, body.client_id, result.settings, given
        ),
        "client_id": body.client_id,
    }
    if previous_client_id is not None and previous_client_id != body.client_id:
        details["previous_client_id"] = previous_client_id
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
        **await _entry(
            session, session_factory, apps, store, user, organization_id, spec
        ),
        "checks": checks_body(result),
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
    row = await store.get(session, organization_id, service)
    if row is None:
        raise HTTPException(409, f"Your organization has no {spec.name} app to check.")
    values, load_error, _ = _opened(apps, store, spec, row)
    if values is None:
        raise HTTPException(409, load_error or f"{spec.name}'s app cannot be read.")
    result = await check_values(apps, spec, values, saved_app_redirects(apps, spec))
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
    usage = await _usage(session_factory, user, organization_id, service)
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
        await _usage(session_factory, user, organization_id, service)
    ).through(removed.client_id)
    return {"connected_members": people, "workspaces": workspaces}
