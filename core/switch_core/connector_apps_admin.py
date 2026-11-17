"""`switch-connector-apps`: the apps the deployment's connectors sign in
through, for the platform operator (`operator_commands.py`). On a deployment
with one organization its admins set them up in the dashboard too
(`gateway/connector_apps.py`); on one with several, this is the way.

- `list` prints each connector's app: where it comes from (configuration, a
  saved app, or none), its client id, and which secrets are set.
- `set SERVICE --file APP.json` saves an app, checked with the vendor first
  exactly as the dashboard's save is, and stored only if the vendor accepts
  it. The file holds the dashboard's save body: `client_id`, the secrets the
  app has (`client_secret`, `private_key`) and `replace`, true to switch to a
  different app.
- `remove SERVICE` removes a saved app; connections made through it stay,
  unusable until an app is set up again.

A change takes effect in every running server at once (`app_signals.py`).
Nothing prints a secret: not the file's, and not one stored. A save is
recorded as last made by the server's administrator account
(GATEWAY_ADMIN_EMAIL), which outlives every other account, and each change
in the server's audit log, with no actor and `PLATFORM_OPERATOR_COMMAND`
set.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.connections.app_checks import CheckResult
from switch_core.connections.app_credentials import ConnectorApps
from switch_core.connections.app_signals import CONNECTOR_APP_CHANGED_SIGNAL
from switch_core.connections.registry import ClientRegistration
from switch_core.db.audit import (
    PLATFORM_OPERATOR_COMMAND,
    ServerAuditAction,
    record_server_audit_event,
)
from switch_core.db.models import User
from switch_core.gateway.connector_apps import (
    SaveApp,
    StoredApp,
    app_spec,
    checked_save,
    refuse_while_blocked,
    refuse_while_configured,
    server_app_redirects,
)
from switch_core.main import build_connector_apps
from switch_core.operator_commands import (
    CommandRefused,
    account_by_email,
    database,
    read_text_file,
    run,
    signals,
)
from switch_core.outbound import guarded_async_client
from switch_core.signals import SignalBus
from switch_core.tenant_context import no_tenant


@asynccontextmanager
async def loaded_connector_apps(
    config: SwitchConfig, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[ConnectorApps]:
    """Each connector's app as the server resolves it, reaching vendors as
    the server does, under its outbound policy."""
    async with guarded_async_client(config.outbound_policy, timeout=20) as http:
        apps = build_connector_apps(
            config,
            session_factory=session_factory,
            http=http,
            registration=ClientRegistration(
                session_factory=session_factory,
                keyring=config.keyring,
                public_url=config.gateway_public_url,
                server_name=config.id_server_name,
                redirects=config.service_sign_in_redirect,
            ),
        )
        await apps.load()
        yield apps


@dataclass(frozen=True)
class AppListing:
    slug: str
    name: str
    # "configuration", "saved" or "none".
    source: str
    client_id: str | None
    # Each secret the app has, and whether it is set. Never the secret.
    secrets: dict[str, bool]
    load_error: str | None
    updated_at: datetime | None


async def list_apps(
    apps: ConnectorApps, session_factory: async_sessionmaker[AsyncSession]
) -> list[AppListing]:
    listings: list[AppListing] = []
    with no_tenant():
        async with session_factory() as session:
            for spec in apps.specs.values():
                effective = apps.effective(spec.service)
                row = await apps.store.get(session, spec.service)
                given = {} if effective.values is None else effective.values.secrets
                listings.append(
                    AppListing(
                        slug=spec.service,
                        name=spec.name,
                        source=effective.source,
                        client_id=(
                            effective.values.client_id
                            if effective.values is not None
                            else (None if row is None else row.client_id)
                        ),
                        secrets={
                            name: name in given or row is not None
                            for name in sorted(spec.secret_names)
                        },
                        load_error=effective.load_error,
                        updated_at=None if row is None else row.updated_at,
                    )
                )
    return listings


def print_apps(listings: list[AppListing]) -> None:
    for app in listings:
        secrets = ", ".join(
            f"{name} {'set' if is_set else 'not set'}"
            for name, is_set in app.secrets.items()
        )
        print(f"{app.slug} ({app.name}): {app.source}")
        print(f"  client id: {app.client_id or '-'}")
        print(f"  secrets: {secrets or '-'}")
        if app.updated_at is not None:
            print(f"  saved: {app.updated_at.isoformat()}")
        if app.load_error is not None:
            print(f"  can't be used: {app.load_error}")


def parse_save(text: str) -> SaveApp:
    """The dashboard's save body, validated as the route validates it. A
    refusal names each field and what is wrong with it, never the value."""
    try:
        return SaveApp.model_validate_json(text)
    except ValidationError as error:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in problem['loc']) or 'the file'}: "
            f"{problem['msg']}"
            for problem in error.errors(include_input=False, include_url=False)
        )
        raise CommandRefused(f"The app file won't do: {problems}") from None


def _refusal(error: HTTPException) -> CommandRefused:
    return CommandRefused(str(error.detail))


def _vendor_refusal(response: JSONResponse) -> CommandRefused:
    body = json.loads(bytes(response.body))
    checks = "".join(
        f"\n  {'ok' if check['ok'] else 'failed'}: {check['name']}: {check['message']}"
        for check in body.get("checks", [])
    )
    return CommandRefused(f"The vendor refused it: {body['detail']}{checks}")


async def set_app(
    apps: ConnectorApps,
    session_factory: async_sessionmaker[AsyncSession],
    bus: SignalBus,
    *,
    service: str,
    body: SaveApp,
    admin_email: str,
) -> CheckResult:
    """Save `service`'s app as the dashboard's save does: refused while
    configuration sets it or the server can't have it, checked with the
    vendor, and stored only if the vendor accepts it. Every running server
    applies it once told."""
    administrator: User = await account_by_email(session_factory, admin_email)
    try:
        spec = app_spec(apps, service)
        refuse_while_configured(apps.effective(service))
        refuse_while_blocked(spec, apps.public_url)
        with no_tenant():
            async with session_factory() as session:
                row = await apps.store.get(session, service)
                checked = await checked_save(
                    apps,
                    spec,
                    body,
                    None
                    if row is None
                    else StoredApp(
                        row.client_id, row.settings, lambda: apps.store.secrets(row)
                    ),
                    server_app_redirects(apps, spec, apps.effective(service)),
                )
                if isinstance(checked, JSONResponse):
                    raise _vendor_refusal(checked)
                await apps.store.save(
                    session,
                    service=service,
                    client_id=body.client_id,
                    settings=checked.result.settings,
                    secrets=checked.given,
                    secret_names=spec.secret_names,
                    updated_by=administrator.id,
                )
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=ServerAuditAction.CONNECTOR_APP_SAVED,
                    target_type="service",
                    target_id=service,
                    details={
                        **checked.details(service, body.client_id),
                        PLATFORM_OPERATOR_COMMAND: True,
                    },
                )
                await session.commit()
    except HTTPException as error:
        raise _refusal(error) from None
    bus.publish(CONNECTOR_APP_CHANGED_SIGNAL, service=service)
    return checked.result


async def remove_app(
    apps: ConnectorApps,
    session_factory: async_sessionmaker[AsyncSession],
    bus: SignalBus,
    *,
    service: str,
) -> str:
    """Remove `service`'s saved app, as the dashboard does; the client id it
    had."""
    try:
        spec = app_spec(apps, service)
        refuse_while_configured(apps.effective(service))
    except HTTPException as error:
        raise _refusal(error) from None
    with no_tenant():
        async with session_factory() as session:
            removed = await apps.store.remove(session, service)
            if removed is None:
                raise CommandRefused(f"{spec.name} has no saved app.")
            client_id = removed.client_id
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.CONNECTOR_APP_REMOVED,
                target_type="service",
                target_id=service,
                details={
                    "service": service,
                    "client_id": client_id,
                    PLATFORM_OPERATOR_COMMAND: True,
                },
            )
            await session.commit()
    bus.publish(CONNECTOR_APP_CHANGED_SIGNAL, service=service)
    return client_id


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-connector-apps",
        description=(
            "The apps this Switch deployment's connectors sign in through, for "
            "its platform operator. Run it where switch-core runs, with the "
            "same configuration. A change takes effect in every running server "
            "at once and is recorded in the server's audit log. Nothing it "
            "prints is a secret."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "list",
        help="each connector's app",
        description=(
            "Print each connector's app: where it comes from (configuration, "
            "saved, or none), its client id, and which secrets are set. "
            "Changes nothing."
        ),
    )
    save = commands.add_parser(
        "set",
        help="save a connector's app, checked with the vendor first",
        description=(
            "Save SERVICE's app from a JSON file holding client_id, the "
            "secrets the app has (client_secret, and for GitHub private_key) "
            'and "replace": true to switch to a different app (false '
            "otherwise). A secret left out keeps the stored one. The vendor is "
            "asked first, and nothing is stored unless it accepts the app. "
            "Refused while Switch's configuration sets the app."
        ),
    )
    save.add_argument("service", help="the connector's slug, as list shows it")
    save.add_argument(
        "--file", type=Path, required=True, help="the JSON file with the app"
    )
    remove = commands.add_parser(
        "remove",
        help="remove a connector's saved app",
        description=(
            "Remove SERVICE's saved app. Connections made through it stay, "
            "and can't be used until an app is set up again."
        ),
    )
    remove.add_argument("service", help="the connector's slug, as list shows it")
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    try:
        body = (
            parse_save(read_text_file(arguments.file, "the app file"))
            if arguments.command == "set"
            else None
        )
        async with (
            database(config, restricted=False) as session_factory,
            loaded_connector_apps(config, session_factory) as apps,
        ):
            if arguments.command == "list":
                print_apps(await list_apps(apps, session_factory))
                return 0
            async with signals(config, session_factory, "switch-connector-apps") as bus:
                if body is not None:
                    result = await set_app(
                        apps,
                        session_factory,
                        bus,
                        service=arguments.service,
                        body=body,
                        admin_email=config.gateway_admin_email,
                    )
                    for check in result.checks:
                        note = f" ({check.note})" if check.note else ""
                        print(f"ok: {check.name}: {check.message}{note}")
                    print(f"Saved {arguments.service}'s app.")
                else:
                    client_id = await remove_app(
                        apps, session_factory, bus, service=arguments.service
                    )
                    print(f"Removed {arguments.service}'s app ({client_id}).")
    except CommandRefused as refused:
        print(f"Refused: {refused}", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    run(_parser(), _run)
