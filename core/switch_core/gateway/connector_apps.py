"""The operator sets up the apps connectors sign in through.

Deployment-operator only: `require_admin` (`users.role == "admin"`) gates
every route here, never `require_tenant_admin`, since one app serves every
workspace on the server. A workspace admin keeps the switch per service
(`gateway/workspace_services.py`) and nothing more. Mounted only with the
`service_connections` flag, with the rest of service connections, so a
server without the feature shows none of it; an app saved earlier still
loads at boot and serves GitHub's own sign-in.

Where an app comes from, and why configuration wins over a saved one, is
`connections/app_credentials.py`. A save is checked with the vendor first
(`connections/app_checks.py`) and stored only if the vendor accepts it; it
takes effect at once, in every process (`connections/app_signals.py`). No
response carries a secret: a client secret shows its last four characters,
a private key its fingerprint.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.app_checks import (
    CheckResult,
    VendorUnreachableError,
    check_app,
)
from switch_core.connections.app_credentials import (
    GITHUB_NEEDS_HTTPS,
    AppSpec,
    AppValues,
    ConnectorApps,
    EffectiveCredentials,
    github_needs_https,
)
from switch_core.connections.broker import ServiceBroker, get_service_broker
from switch_core.connections.loader import CATALOG
from switch_core.connections.oauth_clients import redirect_uris
from switch_core.connections.registry import every_scope
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    OrganizationAppCredential,
    ServiceAppCredential,
    ServiceConnection,
    ServiceOAuthClient,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.app_secrets import MissingSecretsError
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.gateway.auth import require_admin
from switch_core.gateway.dependencies import get_session, get_session_factory
from switch_core.keys import UndecryptableError
from switch_core.providers.github_installation import GitHubInstallationCredentials

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/connector-apps")

GITHUB_CALLBACK_PATH = "/gateway/provider-connections/github/callback"


def get_connector_apps(request: Request) -> ConnectorApps:
    apps = getattr(request.app.state, "connector_apps", None)
    if not isinstance(apps, ConnectorApps):
        raise RuntimeError("No connector apps are installed on this app.")
    return cast(ConnectorApps, apps)


class SaveApp(BaseModel):
    """A save. A secret left out keeps the stored one; the first save, or
    one replacing a row no key opens, names them all. `replace` says the
    operator means to switch to another app: a different `client_id` is
    refused without it."""

    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(min_length=1, max_length=512, pattern=r"^\S+$")
    client_secret: str | None = Field(default=None, min_length=1, max_length=4096)
    private_key: str | None = Field(default=None, min_length=1, max_length=16384)
    replace: bool


@dataclass(frozen=True)
class Usage:
    """The connections a service has across every workspace."""

    # (tenant, status, recorded client) for each connection.
    rows: list[tuple[str, str, str | None]]

    def through(self, client_id: str | None) -> tuple[int, int]:
        """People and workspaces whose live connection goes through
        `client_id`; one recorded before clients were is taken to."""
        affected = [
            tenant
            for tenant, status, recorded in self.rows
            if status == "active" and (recorded is None or recorded == client_id)
        ]
        return len(affected), len(set(affected))

    def not_through(self, proposed: str, current: str | None) -> tuple[int, int]:
        """People and workspaces who must reconnect if `proposed` replaces
        `current`."""
        affected = [
            tenant
            for tenant, status, recorded in self.rows
            if status == "active" and (recorded or current) != proposed
        ]
        return len(affected), len(set(affected))

    def stale(self, current: str | None) -> int:
        """Connections made through an app this server no longer uses."""
        if current is None:
            return 0
        return sum(
            1
            for _, _, recorded in self.rows
            if recorded is not None and recorded != current
        )


@dataclass(frozen=True)
class Usages:
    """Every service's connections across some workspaces."""

    rows: dict[str, list[tuple[str, str, str | None]]]

    def of(self, service: str) -> Usage:
        return Usage(self.rows.get(service, []))


async def usages_in(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_ids: list[str],
    *,
    leave_out_organization_apps: bool,
) -> Usages:
    """Every service's connections in `tenant_ids`, read one workspace at a
    time, each bound before it is touched. With `leave_out_organization_apps`,
    a workspace's connections to a service its organization saved its own app
    for are left out: they never went through the server's."""
    rows: dict[str, list[tuple[str, str, str | None]]] = {}
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            own: set[str] = set()
            if leave_out_organization_apps:
                own = set(
                    await session.scalars(
                        select(OrganizationAppCredential.service)
                        .join(
                            Tenant,
                            Tenant.organization_id
                            == OrganizationAppCredential.organization_id,
                        )
                        .where(Tenant.id == tenant_id)
                    )
                )
            result = await session.execute(
                select(
                    ServiceConnection.service,
                    ServiceConnection.status,
                    ServiceConnection.oauth_client_id,
                ).where(ServiceConnection.tenant_id == tenant_id)
            )
            for service, status, client in result:
                if service not in own:
                    rows.setdefault(service, []).append((tenant_id, status, client))
    return Usages(rows)


def organization_apps_on(request: Request) -> bool:
    """Whether workspaces may go through their organization's own apps
    (`organization_connector_apps`), so the server's apps serve only the
    rest."""
    return getattr(request.app.state, "organization_apps", None) is not None


async def _usages(
    session_factory: async_sessionmaker[AsyncSession], organization_apps: bool
) -> Usages:
    """Every connection made through the server's apps, in every workspace."""
    return await usages_in(
        session_factory,
        await all_tenant_ids(session_factory),
        leave_out_organization_apps=organization_apps,
    )


def app_spec(apps: ConnectorApps, service: str) -> AppSpec:
    spec = apps.specs.get(service)
    if spec is None:
        raise HTTPException(404, f"{service} has no app to set up on this server.")
    return spec


def setup_blocked(spec: AppSpec, public_url: str | None) -> str | None:
    """Why the operator can't set this app up here, known before any vendor
    is asked. An unset GATEWAY_PUBLIC_URL is the page's own banner; Google
    accepts an http redirect for local development, GitHub does not."""
    if github_needs_https(spec.kind, public_url):
        return GITHUB_NEEDS_HTTPS
    return None


def refuse_while_blocked(spec: AppSpec, public_url: str | None) -> None:
    blocked = setup_blocked(spec, public_url)
    if blocked is not None:
        raise HTTPException(409, blocked)


def _redirects(
    apps: ConnectorApps, spec: AppSpec, effective: EffectiveCredentials
) -> list[str]:
    """Every address the vendor sends people back to Switch at, for the
    operator to register: Core's own callback, which needs the public URL,
    or Switch Console's listener on loopback, which does not."""
    if spec.kind == "github_app" and effective.github_app is not None:
        return [effective.github_app.connections.callback]
    return saved_app_redirects(apps, spec)


def saved_app_redirects(apps: ConnectorApps, spec: AppSpec) -> list[str]:
    """Where the vendor sends people back to an app saved here, the server's
    or an organization's: a saved GitHub App is called back at
    GATEWAY_PUBLIC_URL."""
    public_url = apps.public_url
    if spec.kind == "github_app":
        return (
            []
            if public_url is None or setup_blocked(spec, public_url) is not None
            else [public_url.rstrip("/") + GITHUB_CALLBACK_PATH]
        )
    oauth = apps.definition(spec.service).auth.oauth
    assert oauth is not None
    return redirect_uris(spec.service, oauth.redirect, public_url, oauth.loopback_ports)


def needs_public_url(apps: ConnectorApps, spec: AppSpec) -> bool:
    if spec.kind == "github_app":
        return True
    oauth = apps.definition(spec.service).auth.oauth
    assert oauth is not None
    return "core" in oauth.redirect


def app_scopes(apps: ConnectorApps, spec: AppSpec) -> list[str]:
    """What a sign-in asks for, for a vendor whose app lists its scopes."""
    if spec.kind == "github_app":
        return []
    return every_scope(apps.definition(spec.service))


def secret_views(
    spec: AppSpec, secrets: dict[str, str] | None, stored: bool
) -> dict[str, dict[str, Any]]:
    """Whether each secret is set, and how the operator recognises it: never
    the secret, never more than its last four characters."""
    views: dict[str, dict[str, Any]] = {}
    for name in sorted(spec.secret_names):
        value = None if secrets is None else secrets.get(name)
        if name == "private_key":
            fingerprint = None
            if value is not None:
                try:
                    fingerprint = GitHubInstallationCredentials(
                        "unused", value.encode()
                    ).fingerprint
                except ValueError:
                    # A key that does not load: the entry's `load_error` says so.
                    pass
            views[name] = {
                "set": value is not None or stored,
                "fingerprint": fingerprint,
            }
        else:
            views[name] = {
                "set": value is not None or stored,
                "last4": None if value is None or len(value) < 8 else value[-4:],
            }
    return views


@dataclass(frozen=True)
class SavedApp:
    """A saved app's row, the server's or an organization's, as its entry
    shows it."""

    client_id: str
    settings: dict[str, Any]
    updated_at: datetime
    updated_by_name: str | None


async def saved_app(
    session: AsyncSession,
    row: ServiceAppCredential | OrganizationAppCredential | None,
) -> SavedApp | None:
    if row is None:
        return None
    author = None if row.updated_by is None else await session.get(User, row.updated_by)
    return SavedApp(
        client_id=row.client_id,
        settings=dict(row.settings),
        updated_at=row.updated_at,
        updated_by_name=None if author is None else author.name,
    )


def entry_body(
    apps: ConnectorApps,
    spec: AppSpec,
    *,
    source: str,
    configuration_variables: list[str],
    deprecated: bool,
    current: str | None,
    saved: SavedApp | None,
    shown: AppValues | None,
    saved_ignored: bool,
    unreadable: bool,
    load_error: str | None,
    redirects: list[str],
    usage: Usage,
) -> dict[str, Any]:
    """One service's app as a connector-apps page shows it, the server's or
    an organization's: one shape, read by one set of cards. `current` is the
    client in use, if any; `shown` the values whose secrets are described."""
    people, workspaces = usage.through(current) if current is not None else (0, 0)
    settings = (
        shown.settings
        if shown is not None
        else ({} if saved is None else saved.settings)
    )
    slug = settings.get("slug")
    return {
        "slug": spec.service,
        "name": spec.name,
        "kind": spec.kind,
        "source": source,
        "configuration_variables": configuration_variables,
        "deprecated": deprecated,
        "client_id": (
            current
            if current is not None
            else (None if saved is None else saved.client_id)
        ),
        "saved_client_id": None if saved is None else saved.client_id,
        "fields": {"slug": slug} if spec.kind == "github_app" else {},
        "secrets": secret_views(
            spec, None if shown is None else shown.secrets, saved is not None
        ),
        "saved_ignored": saved_ignored,
        "unreadable": unreadable,
        "load_error": load_error,
        # The first of `redirect_uris`, for Consoles that read only one.
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
        "updated_by_name": None if saved is None else saved.updated_by_name,
        "updated_at": None if saved is None else saved.updated_at.isoformat(),
        "connected_members": people,
        "workspaces": workspaces,
        "stale_connections": usage.stale(current),
    }


@dataclass(frozen=True)
class _ServerApp:
    """What the server's entry for a service reads through the request's
    session, before its connection is let go for the usage scan."""

    effective: EffectiveCredentials
    saved: SavedApp | None
    shown: AppValues | None


async def _read(
    session: AsyncSession, apps: ConnectorApps, spec: AppSpec
) -> _ServerApp:
    effective = apps.effective(spec.service)
    row = await apps.store.get(session, spec.service)
    saved_values: AppValues | None = None
    if row is not None:
        try:
            saved_values = AppValues(
                row.client_id, dict(row.settings), apps.store.secrets(row)
            )
        except (UndecryptableError, ValueError):
            saved_values = None
    return _ServerApp(
        effective=effective,
        saved=await saved_app(session, row),
        shown=effective.values or saved_values,
    )


def _entry(
    apps: ConnectorApps, spec: AppSpec, read: _ServerApp, usage: Usage
) -> dict[str, Any]:
    effective = read.effective
    return entry_body(
        apps,
        spec,
        source=effective.source,
        configuration_variables=list(
            effective.configuration_variables
            if effective.source == "configuration"
            else spec.variables
        ),
        deprecated=effective.deprecated,
        current=None if effective.values is None else effective.values.client_id,
        saved=read.saved,
        shown=read.shown,
        saved_ignored=effective.saved_ignored,
        unreadable=effective.unreadable,
        load_error=effective.load_error,
        redirects=_redirects(apps, spec, effective),
        usage=usage,
    )


async def _one_entry(
    session: AsyncSession,
    session_factory: async_sessionmaker[AsyncSession],
    apps: ConnectorApps,
    spec: AppSpec,
    organization_apps: bool,
) -> dict[str, Any]:
    """`spec`'s entry, the request's connection let go before the usage
    scan opens one per workspace."""
    read = await _read(session, apps, spec)
    await session.commit()
    usages = await _usages(session_factory, organization_apps)
    return _entry(apps, spec, read, usages.of(spec.service))


async def _registered(session: AsyncSession) -> list[dict[str, Any]]:
    """Services whose client Core registers for itself: nothing to set up."""
    rows = {
        row.service: row for row in await session.scalars(select(ServiceOAuthClient))
    }
    entries = []
    for slug, entry in CATALOG.items():
        oauth = entry.definition.auth.oauth
        if (
            not entry.definition.enabled
            or entry.definition.adapter != "oauth"
            or oauth is None
            or oauth.registration != "dynamic"
        ):
            continue
        row = rows.get(slug)
        entries.append(
            {
                "slug": slug,
                "name": entry.definition.name,
                "kind": "registered",
                "client_id": None if row is None else row.oauth_client_id,
                "registered_at": None if row is None else row.created_at.isoformat(),
            }
        )
    return entries


def _refuse_while_configured(effective: EffectiveCredentials) -> None:
    if effective.source == "configuration":
        variables = " and ".join(effective.configuration_variables)
        verb = "are" if len(effective.configuration_variables) > 1 else "is"
        raise HTTPException(
            409,
            f"{variables} {verb} set, so Switch uses that. Copy it into Switch, "
            "then unset it and restart.",
        )


def checks_body(result: CheckResult) -> list[dict[str, Any]]:
    return [
        {
            "name": check.name,
            "ok": check.ok,
            "message": check.message,
            "field": check.field,
            "note": check.note,
        }
        for check in result.checks
    ]


async def check_values(
    apps: ConnectorApps, spec: AppSpec, values: AppValues, redirects: list[str]
) -> CheckResult:
    """Ask the vendor whether `values` work as an app sending people back to
    `redirects`; nothing is stored."""
    if not redirects:
        raise HTTPException(
            409,
            "Set GATEWAY_PUBLIC_URL first: the vendor needs to know where to send "
            "people back to Switch.",
        )
    try:
        return await check_app(
            apps.http,
            spec,
            apps.definition(spec.service),
            values,
            redirects[0],
        )
    except VendorUnreachableError as error:
        raise HTTPException(503, str(error)) from None


def fields_changed(
    previous: AppValues | None,
    client_id: str,
    settings: dict[str, str],
    given: dict[str, str],
) -> list[str]:
    if previous is None:
        return sorted({"client_id", *settings, *given})
    changed = {
        name for name, value in given.items() if previous.secrets.get(name) != value
    }
    if previous.client_id != client_id:
        changed.add("client_id")
    changed.update(
        name for name, value in settings.items() if previous.settings.get(name) != value
    )
    return sorted(changed)


@dataclass(frozen=True)
class StoredApp:
    """The app saved for a service before a save, the server's or an
    organization's. `secrets` raises `UndecryptableError` when no key opens
    them."""

    client_id: str
    settings: dict[str, Any]
    secrets: Callable[[], dict[str, str]]


@dataclass(frozen=True)
class CheckedSave:
    """A save the vendor accepted: what to store, and what it changed."""

    result: CheckResult
    previous: AppValues | None
    given: dict[str, str]
    previous_client_id: str | None

    def details(self, service: str, client_id: str) -> dict[str, Any]:
        """The save as its audit event records it: never a secret."""
        details: dict[str, Any] = {
            "service": service,
            "fields_changed": fields_changed(
                self.previous, client_id, self.result.settings, self.given
            ),
            "client_id": client_id,
        }
        if self.previous_client_id not in (None, client_id):
            details["previous_client_id"] = self.previous_client_id
        return details


async def checked_save(
    apps: ConnectorApps,
    spec: AppSpec,
    body: SaveApp,
    stored: StoredApp | None,
    redirects: list[str],
) -> CheckedSave | JSONResponse:
    """Everything a save asks before anything is stored, the server's or an
    organization's: the secrets it names, that a different app is meant, and
    what the vendor says. A refusal from the vendor comes back as the
    response to send."""
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
    if stored is not None and stored.client_id != body.client_id and not body.replace:
        raise HTTPException(
            409,
            "This is a different app: everyone connected through the current one "
            "would have to reconnect. Use a different app to switch on purpose.",
        )
    previous: AppValues | None = None
    if stored is not None:
        try:
            previous = AppValues(
                stored.client_id, dict(stored.settings), stored.secrets()
            )
        except UndecryptableError:
            if not spec.secret_names <= set(given):
                raise HTTPException(
                    422,
                    "Switch can't read the saved secret any more. Enter every "
                    "secret again.",
                ) from None
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
        redirects,
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
    return CheckedSave(
        result=result,
        previous=previous,
        given=given,
        previous_client_id=None if stored is None else stored.client_id,
    )


@router.get("")
async def list_connector_apps(
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    organization_apps: Annotated[bool, Depends(organization_apps_on)],
    _admin: Annotated[User, Depends(require_admin)],
) -> dict[str, Any]:
    reads = [(spec, await _read(session, apps, spec)) for spec in apps.specs.values()]
    registered = await _registered(session)
    # The request's connection goes back before the scan opens one per workspace.
    await session.commit()
    usages = await _usages(session_factory, organization_apps)
    return {
        "public_url": apps.public_url,
        "apps": [
            _entry(apps, spec, read, usages.of(spec.service)) for spec, read in reads
        ],
        "registered": registered,
    }


@router.put("/{service}", response_model=None)
async def save_connector_app(
    service: str,
    body: SaveApp,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    organization_apps: Annotated[bool, Depends(organization_apps_on)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict[str, Any] | JSONResponse:
    spec = app_spec(apps, service)
    _refuse_while_configured(apps.effective(service))
    refuse_while_blocked(spec, apps.public_url)
    row = await apps.store.get(session, service)
    checked = await checked_save(
        apps,
        spec,
        body,
        None
        if row is None
        else StoredApp(row.client_id, row.settings, lambda: apps.store.secrets(row)),
        _redirects(apps, spec, apps.effective(service)),
    )
    if isinstance(checked, JSONResponse):
        return checked
    try:
        await apps.store.save(
            session,
            service=service,
            client_id=body.client_id,
            settings=checked.result.settings,
            secrets=checked.given,
            secret_names=spec.secret_names,
            updated_by=admin.id,
        )
    except MissingSecretsError as error:
        raise HTTPException(422, str(error)) from None
    details = checked.details(service, body.client_id)
    await record_server_audit_event(
        session,
        actor_user_id=admin.id,
        action=ServerAuditAction.CONNECTOR_APP_SAVED,
        target_type="service",
        target_id=service,
        details=details,
    )
    await session.commit()
    await apps.apply(service, broker=broker, state=request.app.state)
    apps.announce(service)
    logger.warning(
        "The operator saved %s's app: user=%s fields=%s",
        spec.name,
        admin.id,
        details["fields_changed"],
    )
    # What the vendor said, notes included, for the page to show as a check's.
    return {
        **await _one_entry(session, session_factory, apps, spec, organization_apps),
        "checks": checks_body(checked.result),
    }


@router.post("/{service}/import")
async def import_connector_app(
    service: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    organization_apps: Annotated[bool, Depends(organization_apps_on)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict[str, Any]:
    """Copy the app configuration names into a saved one, so the
    configuration can be removed with nothing retyped."""
    spec = app_spec(apps, service)
    effective = apps.effective(service)
    if effective.source != "configuration" or effective.values is None:
        raise HTTPException(409, f"{spec.name} is not set from configuration.")
    refuse_while_blocked(spec, apps.public_url)
    if effective.deprecated:
        raise HTTPException(
            409,
            "HOSTED_GITHUB_CONFIG_PATH names no private key, so it can't be "
            "copied. Set up the GitHub App here instead, after unsetting it.",
        )
    app = effective.github_app
    if app is not None:
        expected = (
            None
            if apps.public_url is None
            else apps.public_url.rstrip("/") + GITHUB_CALLBACK_PATH
        )
        if app.connections.callback != expected:
            raise HTTPException(
                409,
                f"The configured GitHub App is called back at "
                f"{app.connections.callback}, but a GitHub App saved here is called "
                f"back at GATEWAY_PUBLIC_URL ({apps.public_url or 'unset'}). Make "
                "them the same first.",
            )
    await apps.store.save(
        session,
        service=service,
        client_id=effective.values.client_id,
        settings=effective.values.settings,
        secrets=effective.values.secrets,
        secret_names=spec.secret_names,
        updated_by=admin.id,
    )
    await record_server_audit_event(
        session,
        actor_user_id=admin.id,
        action=ServerAuditAction.CONNECTOR_APP_IMPORTED,
        target_type="service",
        target_id=service,
        details={
            "service": service,
            "client_id": effective.values.client_id,
            "source_variables": list(effective.configuration_variables),
        },
    )
    await session.commit()
    await apps.reload(service)
    apps.announce(service)
    return await _one_entry(session, session_factory, apps, spec, organization_apps)


@router.post("/{service}/check")
async def check_connector_app(
    service: str,
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    _admin: Annotated[User, Depends(require_admin)],
) -> dict[str, Any]:
    """Ask the vendor about the app in use; nothing is stored."""
    spec = app_spec(apps, service)
    effective = apps.effective(service)
    # A configured GitHub App is called back at its own origin, not this URL.
    if effective.source != "configuration":
        refuse_while_blocked(spec, apps.public_url)
    if effective.values is None:
        raise HTTPException(409, f"{spec.name} has no app to check.")
    if effective.deprecated:
        raise HTTPException(
            409, "HOSTED_GITHUB_CONFIG_PATH names no private key to check."
        )
    result = await check_values(
        apps, spec, effective.values, _redirects(apps, spec, effective)
    )
    return {"ok": result.ok, "checks": checks_body(result)}


@router.get("/{service}/impact")
async def connector_app_impact(
    service: str,
    client_id: Annotated[str, Query(min_length=1, max_length=512)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    organization_apps: Annotated[bool, Depends(organization_apps_on)],
    _admin: Annotated[User, Depends(require_admin)],
) -> dict[str, int]:
    """Who would have to reconnect if `client_id` replaced the app in use."""
    app_spec(apps, service)
    values = apps.effective(service).values
    usage = (await _usages(session_factory, organization_apps)).of(service)
    people, workspaces = usage.not_through(
        client_id, None if values is None else values.client_id
    )
    return {"connected_members": people, "workspaces": workspaces}


@router.delete("/{service}")
async def remove_connector_app(
    service: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[Any, Depends(get_session_factory)],
    apps: Annotated[ConnectorApps, Depends(get_connector_apps)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
    organization_apps: Annotated[bool, Depends(organization_apps_on)],
    admin: Annotated[User, Depends(require_admin)],
) -> dict[str, int]:
    """Remove the saved app. The connections made through it are kept, and
    unusable until an app is set up again; they can still be disconnected."""
    spec = app_spec(apps, service)
    _refuse_while_configured(apps.effective(service))
    removed: ServiceAppCredential | None = await apps.store.remove(session, service)
    if removed is None:
        raise HTTPException(404, f"{spec.name} has no saved app.")
    await record_server_audit_event(
        session,
        actor_user_id=admin.id,
        action=ServerAuditAction.CONNECTOR_APP_REMOVED,
        target_type="service",
        target_id=service,
        details={"service": service, "client_id": removed.client_id},
    )
    await session.commit()
    await apps.apply(service, broker=broker, state=request.app.state)
    apps.announce(service)
    logger.warning("The operator removed %s's app: user=%s", spec.name, admin.id)
    people, workspaces = (
        (await _usages(session_factory, organization_apps))
        .of(service)
        .through(removed.client_id)
    )
    return {"connected_members": people, "workspaces": workspaces}
