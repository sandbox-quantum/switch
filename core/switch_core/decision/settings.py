"""Which decision backend a workspace's rooms use, and whether auto-route is
available there.

A workspace chooses in Switch Console (`gateway/decision_settings.py`, stored
in `decision_settings`), or leaves it to the server default: the decision
service in the server's configuration (`DECISION_ENDPOINT_URL`, its key and
timeout). The choices:

- `none`: auto-route is off in the workspace, even with a server default.
- `endpoint`: the workspace's own decision service, with an optional bearer
  key.
- `haiku_anthropic`: Claude Haiku through the Anthropic API, with the
  workspace's key. It runs in the server's decision service, which is told
  the backend and key per request, so it needs a server default.
- `haiku_bedrock`: Claude Haiku on Amazon Bedrock, on the server's own AWS
  credentials, also in the server's decision service.
- `self_hosted`: the model the server's decision service runs itself, on its
  own model server.
- `gemini`: Gemini in the server's decision service, which falls back to
  another model when Gemini is slow if its operator configured one.

The last four run in the server's decision service, told the backend per
request (`SERVICE_BACKENDS`), so they need a server default. Which of them a
workspace is offered is the service's say, from the backends its `/health`
lists (`decision/offers.py`); the gateway reads that when an admin opens or
saves the page. Deciding a message never waits on `/health`: a saved choice
the service has stopped running is a failed decision, counted and told to the
room, not a silent switch to something else.

A stored choice this release does not know (written by a newer release during
a rolling deploy or after a rollback) turns auto-route off in the workspace,
with a warning, rather than sending the workspace's rooms anywhere it did not
choose.

Auto-route is available in a workspace when the `decision_routing` flag is
on and the workspace resolves to a backend other than none. The room detail,
the room toggle and `!auto-route` all ask `DecisionAvailability`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, get_args

from switch_core.db.stores.decision_settings_store import DecisionSettingsStore

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.config import SwitchConfig
    from switch_core.db.models import DecisionSettings

logger = logging.getLogger(__name__)

Backend = Literal[
    "none", "endpoint", "haiku_anthropic", "haiku_bedrock", "self_hosted", "gemini"
]
BACKENDS: frozenset[str] = frozenset(get_args(Backend))
# A choice that runs in the server's decision service, and the backend the
# service is told in `X-Decision-Backend` (its name in the service's
# `/health` `backends`).
ServiceChoice = Literal["haiku_anthropic", "haiku_bedrock", "self_hosted", "gemini"]
SERVICE_BACKENDS: Mapping[ServiceChoice, str] = {
    "haiku_anthropic": "anthropic",
    "haiku_bedrock": "bedrock",
    "self_hosted": "systemone",
    "gemini": "gemini_decision",
}
Source = Literal["workspace", "server_default"]

FLAG_OFF_REASON = (
    "Auto-route isn't switched on here. Whoever runs Switch turns it on "
    "with the decision_routing feature flag."
)
#: Where in Switch Console a workspace admin chooses the decision service.
DECISION_ROUTING_PAGE = "Switch Console → Settings → Message routing"

NO_BACKEND_REASON = (
    "Auto-route needs a decision service. A workspace admin can set one up in "
    f"{DECISION_ROUTING_PAGE}."
)
UNKNOWN_CHOICE_REASON = (
    "This workspace's saved decision service is one this version of Switch "
    "doesn't know, so auto-route is off here until it is updated or a "
    f"workspace admin chooses again in {DECISION_ROUTING_PAGE}."
)
WORKSPACE_OFF_REASON = (
    "This workspace's admins turned auto-route off by choosing no decision "
    f"service. A workspace admin can choose one in {DECISION_ROUTING_PAGE}."
)


@dataclass(frozen=True)
class ServerDefault:
    """The decision service in the server's configuration: every workspace
    that has chosen nothing uses it, and the service-run choices run in it.

    `bedrock_enabled` (`DECISION_BEDROCK_ENABLED`) is read only when that
    service does not list its backends in `/health` (one older than this
    release): then it alone says whether Haiku on Bedrock is offered."""

    endpoint_url: str | None
    api_key: str | None
    bedrock_enabled: bool

    @classmethod
    def from_config(cls, config: SwitchConfig) -> ServerDefault:
        return cls(
            endpoint_url=config.decision_endpoint_url,
            api_key=config.decision_api_key,
            bedrock_enabled=config.decision_bedrock_enabled,
        )

    @property
    def configured(self) -> bool:
        return self.endpoint_url is not None


@dataclass(frozen=True)
class ResolvedSettings:
    """The backend a workspace's decisions go to, and where they come from.

    `api_key_encrypted` is the workspace's stored key, still encrypted; the
    server default's key is the server's own (`ServerDefault.api_key`).
    `backend` is `none` when nothing applies, whether chosen or for want of a
    server default; `reason` then says which.
    """

    source: Source
    backend: Backend
    endpoint: str | None
    api_key_encrypted: str | None
    threshold: float | None
    reason: str | None

    @property
    def has_backend(self) -> bool:
        return self.backend != "none"


def resolve(row: DecisionSettings | None, server: ServerDefault) -> ResolvedSettings:
    """What applies to a workspace whose row is `row` (None: no choice)."""
    if row is None:
        if not server.configured:
            return ResolvedSettings(
                source="server_default",
                backend="none",
                endpoint=None,
                api_key_encrypted=None,
                threshold=None,
                reason=NO_BACKEND_REASON,
            )
        return ResolvedSettings(
            source="server_default",
            backend="endpoint",
            endpoint=server.endpoint_url,
            api_key_encrypted=None,
            threshold=None,
            reason=None,
        )
    reason: str | None = None
    if row.backend not in BACKENDS:
        logger.warning(
            "Workspace %s saved the decision backend %r, which this release does "
            "not know (a newer release wrote it); auto-route is off there until "
            "this release is replaced or an admin chooses again",
            row.tenant_id,
            row.backend[:40],
        )
        backend: Backend = "none"
        reason = UNKNOWN_CHOICE_REASON
    else:
        backend = row.backend  # type: ignore[assignment]
    if backend == "none":
        reason = reason or WORKSPACE_OFF_REASON
    elif backend in SERVICE_BACKENDS and not server.configured:
        # Saved while the server had a decision service, which has since
        # gone: the choice has nowhere to run.
        backend, reason = "none", NO_BACKEND_REASON
    return ResolvedSettings(
        source="workspace",
        backend=backend,
        endpoint=row.endpoint if backend == "endpoint" else None,
        api_key_encrypted=row.api_key_encrypted,
        threshold=row.threshold,
        reason=reason,
    )


@dataclass(frozen=True)
class Availability:
    """Whether auto-route can act in a workspace's rooms, and if not, why and
    who can fix it."""

    available: bool
    reason: str | None


def availability(enabled: bool, settings: ResolvedSettings) -> Availability:
    if not enabled:
        return Availability(available=False, reason=FLAG_OFF_REASON)
    if not settings.has_backend:
        return Availability(available=False, reason=settings.reason)
    return Availability(available=True, reason=None)


@dataclass(frozen=True)
class DecisionAvailability:
    """The one availability check, for the room detail, the room toggle and
    `!auto-route`: the server's flag and default, and the workspace's row."""

    enabled: bool
    server: ServerDefault
    store: DecisionSettingsStore

    @classmethod
    def from_config(cls, config: SwitchConfig) -> DecisionAvailability:
        return cls(
            enabled=config.decision_routing_enabled,
            server=ServerDefault.from_config(config),
            store=DecisionSettingsStore(),
        )

    async def settings(self, session: AsyncSession, tenant_id: str) -> ResolvedSettings:
        return resolve(await self.store.get(session, tenant_id), self.server)

    async def check(self, session: AsyncSession, tenant_id: str) -> Availability:
        return availability(self.enabled, await self.settings(session, tenant_id))
