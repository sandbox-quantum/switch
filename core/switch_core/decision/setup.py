"""Building the decision client at boot."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import httpx

from switch_core.decision.client import SETTINGS_CACHE_SECONDS, DynamicDecisionClient
from switch_core.decision.machine import MachineDecisions
from switch_core.decision.settings import DecisionAvailability
from switch_core.feature_flags import DECISION_ROUTING
from switch_core.outbound import guarded_async_client

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.config import SwitchConfig
    from switch_core.telemetry import TelemetryService

logger = logging.getLogger(__name__)


def build_decision_client(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    telemetry: TelemetryService | None,
    machines: MachineDecisions,
) -> DynamicDecisionClient:
    """The decision client; `main` closes it (`aclose`). A workspace's own
    endpoint is reached through the server's outbound policy
    (`OUTBOUND_ALLOWED_PRIVATE_HOSTS`), the server's decision service directly.

    Built whether or not the `decision_routing` flag is on: workspace admins
    can set up and test a backend before the flag goes on. Only with it on is
    the client handed to the router."""
    if config.decision_routing_enabled and config.decision_endpoint_url is None:
        logger.warning(
            "The %r feature flag is on but DECISION_ENDPOINT_URL is not set: "
            "there is no server default, so auto-route is unavailable in every "
            "workspace whose admins have not chosen a decision service in "
            "Switch Console (Admin → Decision routing), and Haiku is not offered.",
            DECISION_ROUTING,
        )
    return DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability.from_config(config),
        keyring=config.keyring,
        client=httpx.AsyncClient(),
        guarded_client=guarded_async_client(config.outbound_policy),
        outbound_policy=config.outbound_policy,
        timeout_seconds=config.decision_timeout_seconds,
        telemetry=telemetry,
        cache_seconds=SETTINGS_CACHE_SECONDS,
        machines=machines,
    )
