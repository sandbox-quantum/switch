"""The apps connectors sign in through, and where each one comes from.

Some catalog entries need an app the server's operator registers at the
vendor before anyone can connect: GitHub's App (the `github` adapter), and
every OAuth client with `registration: static`. Each comes from one of two
places:

- **configuration**: the files named by `GITHUB_APP_CONFIG_PATH` and
  `GITHUB_APP_PRIVATE_KEY_PATH` (or, for one more release, the deprecated
  `HOSTED_GITHUB_CONFIG_PATH`), or by `<PREFIX>_CLIENT_CONFIG_PATH`;
- **saved**: a `service_app_credentials` row the operator saved from the
  dashboard.

Configuration wins: where it is set, Switch uses it exactly as it always
has, and a saved row is ignored with a warning at startup. A configuration
that is set but unusable stops the server; a saved row that cannot be used
leaves the service not set up, with the reason on the operator's page, so a
bad row cannot lock the operator out of the page that fixes it.

A GitHub App saved here is called back at `GATEWAY_PUBLIC_URL`, which must
then be https; a configured one keeps the `origin` its file names.

A change takes effect without a restart (`ConnectorApps.apply`): the
service's adapter is rebuilt and swapped into the broker, and for GitHub the
App on the gateway's state is swapped too; a sign-in under way is a row, so
it outlives the swap. The process that saved the change applies it at once
and announces it, and every other process applies it on hearing so
(`connections/app_signals.py`). Each process remembers which saved row it
resolved every app from, so one that missed the announcement finds the row
changed on its next re-check.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.datastructures import State

from switch_core.config import SwitchConfig
from switch_core.connections.adapters import ServiceAdapter
from switch_core.connections.adapters.github import GitHubApp, load_github_app
from switch_core.connections.adapters.oauth import OAuthClientCredentials
from switch_core.connections.loader import Connection, ConnectionDefinition
from switch_core.connections.registry import (
    ClientRegistration,
    build_adapter,
    client_settings_variable,
    load_client_settings,
)
from switch_core.db.models import ServiceAppCredential
from switch_core.db.stores.service_app_credential_store import (
    ServiceAppCredentialStore,
)
from switch_core.keys import UndecryptableError
from switch_core.providers.github import GitHubConnections
from switch_core.providers.github_installation import GitHubInstallationCredentials

if TYPE_CHECKING:
    from datetime import datetime

    from switch_core.connections.app_signals import ConnectorAppSignals
    from switch_core.connections.broker import ServiceBroker

logger = logging.getLogger(__name__)

AppKind = Literal["github_app", "oauth_client"]
Source = Literal["configuration", "saved", "none"]

GITHUB_APP_VARIABLES = ("GITHUB_APP_CONFIG_PATH", "GITHUB_APP_PRIVATE_KEY_PATH")
HOSTED_GITHUB_VARIABLE = "HOSTED_GITHUB_CONFIG_PATH"

SECRET_NAMES: dict[AppKind, frozenset[str]] = {
    "github_app": frozenset({"client_secret", "private_key"}),
    "oauth_client": frozenset({"client_secret"}),
}

UNREADABLE = "Switch can't read the saved secret any more."

GITHUB_NEEDS_HTTPS = (
    "GitHub needs GATEWAY_PUBLIC_URL to be an https address, to send people "
    "back to Switch."
)


def app_kind(definition: ConnectionDefinition) -> AppKind | None:
    """The kind of app the operator sets up for `definition`, if any."""
    if definition.adapter == "github":
        return "github_app"
    oauth = definition.auth.oauth
    if (
        definition.adapter == "oauth"
        and oauth is not None
        and oauth.registration == "static"
    ):
        return "oauth_client"
    return None


def needs_operator_app(definition: ConnectionDefinition) -> bool:
    return app_kind(definition) is not None


def github_needs_https(kind: AppKind | None, public_url: str | None) -> bool:
    """Whether a GitHub App can't be set up on a server at `public_url`:
    GitHub sends people back only to an https address. An unset public URL
    is not this: setting it is the operator's first step for every app."""
    return (
        kind == "github_app"
        and public_url is not None
        and urlsplit(public_url).scheme != "https"
    )


def not_set_up(name: str) -> str:
    """What members are told about a service whose app is not set up here."""
    return (
        f"{name} is not set up on this server. Whoever runs your Switch server "
        "can set it up in Switch Console, under Admin → Connector apps."
    )


def cannot_work_here(name: str) -> str:
    """What members are told about a service whose app this server can't
    have: GitHub's, on a server without an https address."""
    return (
        f"{name} can't be used on this server: it needs the server to have an "
        "https address."
    )


def needs_public_url(name: str) -> str:
    """What members are told about a service whose sign-ins return only to
    the server, on a server without a public address."""
    return (
        f"{name} can't be connected on this server: it needs the server's "
        "public address (GATEWAY_PUBLIC_URL)."
    )


@dataclass(frozen=True)
class AppSpec:
    """A catalog entry that needs an app, and what configures it."""

    service: str
    name: str
    kind: AppKind
    variables: tuple[str, ...]

    @property
    def secret_names(self) -> frozenset[str]:
        return SECRET_NAMES[self.kind]


def app_specs(catalog: Mapping[str, Connection]) -> dict[str, AppSpec]:
    specs = {}
    for slug, entry in catalog.items():
        definition = entry.definition
        kind = app_kind(definition)
        if not definition.enabled or kind is None:
            continue
        variables: tuple[str, ...]
        if kind == "github_app":
            variables = GITHUB_APP_VARIABLES
        else:
            assert definition.auth.oauth is not None
            assert definition.auth.oauth.client_settings is not None
            variables = (
                client_settings_variable(definition.auth.oauth.client_settings),
            )
        specs[slug] = AppSpec(slug, definition.name, kind, variables)
    if sum(spec.kind == "github_app" for spec in specs.values()) > 1:
        raise ValueError("The catalog names more than one GitHub App service.")
    return specs


@dataclass(frozen=True)
class AppValues:
    """An app's values: its client id, non-secret settings and secrets."""

    client_id: str
    settings: dict[str, str]
    secrets: dict[str, str] = field(repr=False)


@dataclass(frozen=True)
class EffectiveCredentials:
    """The app a service uses in this process, and where it came from.

    `configuration_variables` are the variables it was read from, when its
    source is configuration. `deprecated` marks GitHub's
    `HOSTED_GITHUB_CONFIG_PATH`, which names no signing key. `saved_ignored`:
    a row is saved but configuration is set, so the row is not used.
    `load_error` says why a saved row could not be used, and `unreadable`
    that no key opens it.
    """

    spec: AppSpec
    source: Source
    values: AppValues | None
    github_app: GitHubApp | None
    oauth_client: OAuthClientCredentials | None
    configuration_variables: tuple[str, ...]
    deprecated: bool
    saved_ignored: bool
    load_error: str | None
    unreadable: bool


@dataclass(frozen=True)
class _Configured:
    values: AppValues
    github_app: GitHubApp | None
    oauth_client: OAuthClientCredentials | None
    variables: tuple[str, ...]
    deprecated: bool


class AppLoadError(Exception):
    """A saved app that cannot be used; the message is for whoever saved it."""


class UnreadableAppError(AppLoadError):
    """No current key opens the saved secrets; saving the app again fixes it."""


class ServerCannotUseAppError(AppLoadError):
    """Nothing is wrong with the saved app, but this server cannot use any
    such app (GitHub's needs an https address), which only its operator can
    change."""


def github_app_from_values(values: AppValues, public_url: str | None) -> GitHubApp:
    """A GitHub App from saved values, called back at `public_url`."""
    if public_url is None or urlsplit(public_url).scheme != "https":
        raise ServerCannotUseAppError(GITHUB_NEEDS_HTTPS)
    try:
        connections = GitHubConnections(
            client_id=values.client_id,
            client_secret=values.secrets["client_secret"],
            slug=values.settings["slug"],
            origin=public_url,
        )
        signer = GitHubInstallationCredentials(
            values.client_id, values.secrets["private_key"].encode()
        )
    except KeyError as missing:
        raise AppLoadError(f"The saved GitHub App has no {missing.args[0]}.") from None
    except ValueError as error:
        raise AppLoadError(str(error)) from None
    return GitHubApp(connections, signer)


@dataclass(frozen=True)
class LoadedApp:
    """A saved app, opened: its values, and the GitHub App or OAuth client
    its adapter takes, the other None."""

    values: AppValues
    github_app: GitHubApp | None
    oauth_client: OAuthClientCredentials | None


def load_saved_app(
    spec: AppSpec,
    *,
    client_id: str,
    settings: Mapping[str, str],
    secrets: Callable[[], dict[str, str]],
    public_url: str | None,
) -> LoadedApp:
    """A saved row's app, the server's or an organization's. `secrets`
    decrypts the row's. Raises `AppLoadError` when it cannot be used."""
    try:
        opened = secrets()
    except UndecryptableError:
        raise UnreadableAppError(UNREADABLE) from None
    values = AppValues(client_id, dict(settings), opened)
    if spec.kind == "github_app":
        return LoadedApp(values, github_app_from_values(values, public_url), None)
    if "client_secret" not in opened:
        raise AppLoadError("The saved client has no client secret.")
    return LoadedApp(
        values,
        None,
        OAuthClientCredentials(client_id, opened["client_secret"], authentication=None),
    )


def install_github_app(state: State, app: GitHubApp | None) -> None:
    """Put `app` on the gateway's state. A sign-in under way is a row in
    `sign_in_flows`, so it outlives the swap on its own; one that started
    under another client is refused as it completes."""
    state.github_app = app
    state.github_connections = None if app is None else app.connections


def _changed_at(row: ServiceAppCredential | None) -> datetime | None:
    return None if row is None else row.updated_at


class ConnectorApps:
    """Every connector's app, as this process uses it."""

    def __init__(
        self,
        *,
        catalog: dict[str, Connection],
        config: SwitchConfig,
        environ: Mapping[str, str],
        session_factory: async_sessionmaker[AsyncSession],
        store: ServiceAppCredentialStore,
        http: httpx.AsyncClient,
        registration: ClientRegistration,
    ) -> None:
        self.specs = app_specs(catalog)
        self._catalog = catalog
        self._config = config
        self._environ = environ
        self._session_factory = session_factory
        self._store = store
        self._http = http
        self._registration = registration
        self._configured: dict[str, _Configured | None] = {}
        self._effective: dict[str, EffectiveCredentials] = {}
        # When each service's saved row was last changed, as this process
        # resolved it; None where there was no row.
        self._resolved_at: dict[str, datetime | None] = {}
        self._signals: ConnectorAppSignals | None = None

    @property
    def store(self) -> ServiceAppCredentialStore:
        return self._store

    @property
    def public_url(self) -> str | None:
        return self._config.gateway_public_url

    @property
    def http(self) -> httpx.AsyncClient:
        """How this server reaches vendors, held to its outbound policy."""
        return self._http

    def definition(self, service: str) -> ConnectionDefinition:
        return self._catalog[service].definition

    async def load(self) -> None:
        """Resolve every app, at startup. Configuration that is set but
        cannot be used raises, as it always has."""
        self._configured = {
            service: self._configuration(spec) for service, spec in self.specs.items()
        }
        async with self._session_factory() as session:
            rows = await self._store.list_all(session)
        for service, spec in self.specs.items():
            effective = self._resolve(spec, rows.get(service))
            if effective.saved_ignored:
                logger.warning(
                    "%s has an app saved from the dashboard, but %s is set, so "
                    "Switch uses that and ignores the saved app.",
                    spec.name,
                    " and ".join(effective.configuration_variables),
                )
            self._effective[service] = effective
            self._resolved_at[service] = _changed_at(rows.get(service))

    async def reload(self, service: str) -> EffectiveCredentials:
        """Resolve one service's app again, after its row changed."""
        spec = self.specs[service]
        async with self._session_factory() as session:
            row = await self._store.get(session, service)
        effective = self._resolve(spec, row)
        self._effective[service] = effective
        self._resolved_at[service] = _changed_at(row)
        return effective

    def use_signals(self, signals: ConnectorAppSignals) -> None:
        """Announce each change made here, so every other process applies
        it too (`app_signals.py`)."""
        self._signals = signals

    def announce(self, service: str) -> None:
        """Tell every other process that `service`'s saved app changed, once
        the change has committed and been applied here."""
        if self._signals is not None:
            self._signals.changed(service)

    async def changed_since_resolved(self) -> list[str]:
        """The services whose saved row changed, appeared or went since this
        process last resolved them: what a missed announcement leaves behind.
        A read, never a write."""
        async with self._session_factory() as session:
            rows = await self._store.list_all(session)
        return [
            service
            for service in self.specs
            if _changed_at(rows.get(service)) != self._resolved_at.get(service)
        ]

    async def apply(
        self, service: str, *, broker: ServiceBroker, state: State
    ) -> EffectiveCredentials:
        """Resolve `service`'s app again and put it to work at once."""
        effective = await self.reload(service)
        broker.replace_adapter(
            service,
            self.build(
                service,
                github_app=effective.github_app,
                oauth_client=effective.oauth_client,
            ),
        )
        if effective.spec.kind == "github_app":
            install_github_app(state, effective.github_app)
        return effective

    def build(
        self,
        service: str,
        *,
        github_app: GitHubApp | None,
        oauth_client: OAuthClientCredentials | None,
    ) -> ServiceAdapter | None:
        """`service`'s adapter over the given app, or None without one."""
        return build_adapter(
            service,
            self._catalog[service].definition,
            github_app=github_app,
            oauth_client=oauth_client,
            http=self._http,
            registration=self._registration,
        )

    def effective(self, service: str) -> EffectiveCredentials:
        effective = self._effective.get(service)
        if effective is None:
            raise KeyError(f"{service} has no connector app, or apps are not loaded.")
        return effective

    def github_app(self) -> GitHubApp | None:
        for service, spec in self.specs.items():
            if spec.kind == "github_app":
                return self.effective(service).github_app
        return None

    def oauth_clients(self) -> dict[str, OAuthClientCredentials]:
        return {
            service: client
            for service in self.specs
            if (client := self.effective(service).oauth_client) is not None
        }

    def _configuration(self, spec: AppSpec) -> _Configured | None:
        if spec.kind == "oauth_client":
            oauth = self._catalog[spec.service].definition.auth.oauth
            assert oauth is not None and oauth.client_settings is not None
            settings = load_client_settings(oauth.client_settings, self._environ)
            if settings is None:
                return None
            client = OAuthClientCredentials(
                settings.client_id, settings.client_secret, authentication=None
            )
            return _Configured(
                values=AppValues(
                    settings.client_id, {}, {"client_secret": settings.client_secret}
                ),
                github_app=None,
                oauth_client=client,
                variables=spec.variables,
                deprecated=False,
            )
        app = load_github_app(self._config)
        if app is None:
            return None
        secrets = {"client_secret": app.connections.client_secret}
        key_path = self._config.github_app_private_key_path
        deprecated = app.signer is None
        if key_path is not None:
            secrets["private_key"] = Path(key_path).read_text("utf-8")
        return _Configured(
            values=AppValues(
                app.connections.client_id, {"slug": app.connections.slug}, secrets
            ),
            github_app=app,
            oauth_client=None,
            variables=(HOSTED_GITHUB_VARIABLE,) if deprecated else spec.variables,
            deprecated=deprecated,
        )

    def _resolve(
        self, spec: AppSpec, row: ServiceAppCredential | None
    ) -> EffectiveCredentials:
        configured = self._configured.get(spec.service)
        if configured is not None:
            return EffectiveCredentials(
                spec=spec,
                source="configuration",
                values=configured.values,
                github_app=configured.github_app,
                oauth_client=configured.oauth_client,
                configuration_variables=configured.variables,
                deprecated=configured.deprecated,
                saved_ignored=row is not None,
                load_error=None,
                unreadable=False,
            )
        if row is None:
            return self._none(spec, load_error=None, unreadable=False)
        try:
            loaded = load_saved_app(
                spec,
                client_id=row.client_id,
                settings=row.settings,
                secrets=lambda: self._store.secrets(row),
                public_url=self.public_url,
            )
        except UnreadableAppError:
            logger.error(
                "The app saved for %s cannot be decrypted with any current key; "
                "%s is not set up until it is saved again.",
                spec.name,
                spec.name,
            )
            return self._none(spec, load_error=UNREADABLE, unreadable=True)
        except AppLoadError as error:
            logger.error(
                "The app saved for %s cannot be used, so it is not set up: %s",
                spec.name,
                error,
            )
            return self._none(spec, load_error=str(error), unreadable=False)
        return EffectiveCredentials(
            spec=spec,
            source="saved",
            values=loaded.values,
            github_app=loaded.github_app,
            oauth_client=loaded.oauth_client,
            configuration_variables=(),
            deprecated=False,
            saved_ignored=False,
            load_error=None,
            unreadable=False,
        )

    def _none(
        self, spec: AppSpec, *, load_error: str | None, unreadable: bool
    ) -> EffectiveCredentials:
        return EffectiveCredentials(
            spec=spec,
            source="none",
            values=None,
            github_app=None,
            oauth_client=None,
            configuration_variables=(),
            deprecated=False,
            saved_ignored=False,
            load_error=load_error,
            unreadable=unreadable,
        )
