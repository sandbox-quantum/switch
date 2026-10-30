"""The connector apps organizations registered, as the broker uses them.

A workspace whose organization saved an app for a service
(`organization_app_credentials`) is issued and refreshed through that app;
one whose organization saved none goes through the server's, as
`connections/app_credentials.py` resolves it. Only GitHub's App and the
static OAuth clients have one. All of this is behind the
`organization_connector_apps` flag: with it off the broker holds no
`OrganizationApps`, and no workspace looks past the server's apps.

An organization's adapter is built the first time one of its workspaces
needs it, and kept. The process that changes an organization's app forgets
the adapter at once and announces the change (`app_signals.py`), and every
other process forgets it on hearing so. A signal can be missed, so a kept
adapter is trusted for `TRUSTED_SECONDS` after its row was last read; the
next lookup after that reads the row again and rebuilds only if the row
changed. Which organization a workspace belongs to is read once and kept:
workspaces do not move between organizations.

An organization's app that cannot be used leaves the service unavailable in
its workspaces, with the reason. It does not fall back to the server's app:
that is not the app the organization chose, and its members would be signed
in to the vendor through someone else's.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ServiceAdapter
from switch_core.connections.app_credentials import (
    UNREADABLE,
    AppLoadError,
    AppValues,
    ConnectorApps,
    app_from_values,
)
from switch_core.db.models import OrganizationAppCredential, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.keys import UndecryptableError
from switch_core.signals import RECHECK_SECONDS

if TYPE_CHECKING:
    from switch_core.connections.app_signals import ConnectorAppSignals

logger = logging.getLogger(__name__)

# How long a kept adapter stands for its row without reading it again: what a
# missed announcement costs, as the server's apps' re-check does.
TRUSTED_SECONDS = RECHECK_SECONDS


def unusable(name: str, error: str) -> str:
    """What members are told about a service whose organization's app
    cannot be used."""
    return (
        f"Your organization's {name} app can't be used: {error} An organization "
        "admin can fix it under Organization, Connectors."
    )


@dataclass(frozen=True)
class OrganizationApp:
    """The app an organization saved for a service, as built here.

    `adapter` is None when the app cannot be used, and `problem` then says
    why, for members to read."""

    organization_id: str
    adapter: ServiceAdapter | None
    problem: str | None
    changed_at: datetime


@dataclass
class _Kept:
    # None when the organization saved no app for the service.
    app: OrganizationApp | None
    read_at: float


class OrganizationApps:
    def __init__(
        self,
        *,
        apps: ConnectorApps,
        store: OrganizationAppCredentialStore,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        self._apps = apps
        self._store = store
        self._session_factory = session_factory
        self._organization_of: dict[str, str] = {}
        self._kept: dict[tuple[str, str], _Kept] = {}
        # Bumped by each `forget`, so a build that read the row before it
        # does not keep what it read.
        self._generation: dict[tuple[str, str], int] = {}
        self._signals: ConnectorAppSignals | None = None

    def use_signals(self, signals: ConnectorAppSignals) -> None:
        """Announce each change made here, so every other process forgets
        the adapter too (`app_signals.py`)."""
        self._signals = signals

    async def for_workspace(
        self, tenant_id: str, service: str
    ) -> OrganizationApp | None:
        """The app `tenant_id`'s organization saved for `service`, or None
        when it saved none and the server's applies."""
        if service not in self._apps.specs:
            return None
        organization_id = self._organization_of.get(tenant_id)
        if organization_id is not None:
            kept = self._kept.get((organization_id, service))
            if kept is not None and time.monotonic() - kept.read_at < TRUSTED_SECONDS:
                return kept.app
        async with tenant_session(self._session_factory, tenant_id) as session:
            if organization_id is None:
                organization_id = await session.scalar(
                    select(Tenant.organization_id).where(Tenant.id == tenant_id)
                )
                # A workspace a process from before organizations created.
                if organization_id is None:
                    return None
                self._organization_of[tenant_id] = organization_id
            key = (organization_id, service)
            generation = self._generation.get(key, 0)
            read_at = time.monotonic()
            row = await self._store.get(session, organization_id, service)
        kept = self._kept.get(key)
        if row is None:
            app = None
        elif (
            kept is not None
            and kept.app is not None
            and kept.app.changed_at == row.updated_at
        ):
            app = kept.app
        else:
            app = self._build(row)
        if self._generation.get(key, 0) == generation:
            self._kept[key] = _Kept(app, read_at)
        return app

    def changed(self, organization_id: str, service: str) -> None:
        """The organization's app for `service` was saved, replaced or
        removed, and the change has committed: forget the adapter here and
        tell every other process to."""
        self.forget(organization_id, service)
        if self._signals is not None:
            self._signals.organization_changed(organization_id, service)

    def forget(self, organization_id: str, service: str) -> None:
        """Drop the adapter kept for the organization's app, after it changed."""
        key = (organization_id, service)
        self._kept.pop(key, None)
        self._generation[key] = self._generation.get(key, 0) + 1

    def forget_all(self) -> None:
        """Drop every kept adapter: after this process may have missed
        announcements, as on reconnecting to the database."""
        for organization_id, service in list(self._kept):
            self.forget(organization_id, service)

    def _build(self, row: OrganizationAppCredential) -> OrganizationApp:
        spec = self._apps.specs[row.service]
        try:
            try:
                secrets = self._store.secrets(row)
            except UndecryptableError:
                raise AppLoadError(UNREADABLE) from None
            github_app, oauth_client = app_from_values(
                spec,
                AppValues(row.client_id, dict(row.settings), secrets),
                self._apps.public_url,
            )
        except AppLoadError as error:
            logger.error(
                "The %s app organization %s saved cannot be used, so %s is "
                "unavailable in its workspaces: %s",
                spec.name,
                row.organization_id,
                spec.name,
                error,
            )
            return OrganizationApp(
                organization_id=row.organization_id,
                adapter=None,
                problem=unusable(spec.name, str(error)),
                changed_at=row.updated_at,
            )
        return OrganizationApp(
            organization_id=row.organization_id,
            adapter=self._apps.build(
                row.service, github_app=github_app, oauth_client=oauth_client
            ),
            problem=None,
            changed_at=row.updated_at,
        )
