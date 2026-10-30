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
  credentials, also in the server's decision service: offered only when the
  operator sets `DECISION_BEDROCK_ENABLED`.
- `machine`: a model served on one of the workspace admin's own agent
  controllers, asked over its connection (`decision/machine.py`). Until the
  machine first reports the model running, auto-route is unavailable there,
  saying it is getting ready, and posts no notices; a revoked or deleted
  machine makes it unavailable too, also without notices. Once ready, a
  machine that is offline, busy or failing takes the failure path.

Auto-route is available in a workspace when the `decision_routing` flag is
on and the workspace resolves to a backend it can ask. The room detail,
the room toggle and `!auto-route` all ask `DecisionAvailability`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.decision.machine import MachineChoice, machine_choice

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from switch_core.config import SwitchConfig
    from switch_core.db.models import AgentController, DecisionSettings

Backend = Literal["none", "endpoint", "haiku_anthropic", "haiku_bedrock", "machine"]
Source = Literal["workspace", "server_default"]

FLAG_OFF_REASON = (
    "Auto-route isn't switched on for this Switch server. Whoever runs the "
    "server turns it on with the decision_routing feature flag."
)
NO_BACKEND_REASON = (
    "Auto-route needs a decision service. A workspace admin can set one up in "
    "Switch Console → Admin → Decision routing."
)
WORKSPACE_OFF_REASON = (
    "This workspace's admins turned auto-route off by choosing no decision "
    "service. A workspace admin can choose one in Switch Console → Admin → "
    "Decision routing."
)


@dataclass(frozen=True)
class ServerDefault:
    """The decision service in the server's configuration: every workspace
    that has chosen nothing uses it, and Haiku runs in it."""

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

    @property
    def haiku_anthropic(self) -> bool:
        """Whether a workspace may choose Haiku on the Anthropic API."""
        return self.configured

    @property
    def haiku_bedrock(self) -> bool:
        """Whether a workspace may choose Haiku on Bedrock."""
        return self.configured and self.bedrock_enabled


@dataclass(frozen=True)
class ResolvedSettings:
    """The backend a workspace's decisions go to, and where they come from.

    `api_key_encrypted` is the workspace's stored key, still encrypted; the
    server default's key is the server's own (`ServerDefault.api_key`).
    `backend` is `none` when nothing applies, whether chosen or for want of a
    server default; `reason` then says which. For `machine`, `machine` is the
    machine as last heard of, and `reason` says why it can't be asked yet.
    """

    source: Source
    backend: Backend
    endpoint: str | None
    api_key_encrypted: str | None
    threshold: float | None
    reason: str | None
    machine: MachineChoice | None

    @property
    def has_backend(self) -> bool:
        """Whether decisions are asked of the backend at all."""
        if self.machine is not None:
            return self.machine.usable
        return self.backend != "none"


def resolve(
    row: DecisionSettings | None,
    server: ServerDefault,
    controller: AgentController | None,
    connected: bool | None,
) -> ResolvedSettings:
    """What applies to a workspace whose row is `row` (None: no choice).
    `controller` is a `machine` row's controller (None when it is gone, and
    for every other backend), and `connected` whether it is connected, None
    where that was not read."""
    if row is None:
        if not server.configured:
            return ResolvedSettings(
                source="server_default",
                backend="none",
                endpoint=None,
                api_key_encrypted=None,
                threshold=None,
                reason=NO_BACKEND_REASON,
                machine=None,
            )
        return ResolvedSettings(
            source="server_default",
            backend="endpoint",
            endpoint=server.endpoint_url,
            api_key_encrypted=None,
            threshold=None,
            reason=None,
            machine=None,
        )
    backend: Backend = row.backend  # type: ignore[assignment]
    reason: str | None = None
    if backend == "machine":
        machine = machine_choice(row, controller, connected)
        return ResolvedSettings(
            source="workspace",
            backend="machine",
            endpoint=None,
            api_key_encrypted=None,
            threshold=row.threshold,
            reason=machine.unavailable_reason,
            machine=machine,
        )
    if backend == "none":
        reason = WORKSPACE_OFF_REASON
    elif backend in ("haiku_anthropic", "haiku_bedrock") and not server.configured:
        # Saved while the server had a decision service, which has since
        # gone: Haiku has nowhere to run.
        backend, reason = "none", NO_BACKEND_REASON
    elif backend == "haiku_bedrock" and not server.bedrock_enabled:
        backend, reason = "none", NO_BACKEND_REASON
    return ResolvedSettings(
        source="workspace",
        backend=backend,
        endpoint=row.endpoint if backend == "endpoint" else None,
        api_key_encrypted=row.api_key_encrypted,
        threshold=row.threshold,
        reason=reason,
        machine=None,
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
    controllers: AgentControllerStore

    @classmethod
    def from_config(cls, config: SwitchConfig) -> DecisionAvailability:
        return cls(
            enabled=config.decision_routing_enabled,
            server=ServerDefault.from_config(config),
            store=DecisionSettingsStore(),
            controllers=AgentControllerStore(),
        )

    async def controller_of(
        self, session: AsyncSession, row: DecisionSettings | None
    ) -> AgentController | None:
        """A `machine` row's controller, None when it is gone or for any
        other row."""
        if row is None or row.backend != "machine" or row.controller_id is None:
            return None
        return await self.controllers.get(session, row.tenant_id, row.controller_id)

    async def settings(self, session: AsyncSession, tenant_id: str) -> ResolvedSettings:
        row = await self.store.get(session, tenant_id)
        return resolve(row, self.server, await self.controller_of(session, row), None)

    async def check(self, session: AsyncSession, tenant_id: str) -> Availability:
        return availability(self.enabled, await self.settings(session, tenant_id))
