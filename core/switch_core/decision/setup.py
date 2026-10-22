"""Building the decision client at boot."""

from __future__ import annotations

import logging

import httpx

from switch_core.config import SwitchConfig
from switch_core.decision.client import DecisionClient
from switch_core.feature_flags import DECISION_ROUTING

logger = logging.getLogger(__name__)


def build_decision_client(
    config: SwitchConfig,
) -> tuple[DecisionClient, httpx.AsyncClient] | None:
    """The decision client, and its HTTP client so `main` can close it; None
    when this server does not route by decision, because the flag is off or
    no endpoint is configured. The second is said in the log, since a room's
    `!auto-route` is then refused."""
    if not config.decision_routing_enabled:
        return None
    if config.decision_endpoint_url is None:
        logger.warning(
            "The %r feature flag is on but DECISION_ENDPOINT_URL is not set: no "
            "message is routed by decision, and `!auto-route` says the server "
            "has no decision service.",
            DECISION_ROUTING,
        )
        return None
    http_client = httpx.AsyncClient()
    return (
        DecisionClient(
            endpoint_url=config.decision_endpoint_url,
            api_key=config.decision_api_key,
            timeout_seconds=config.decision_timeout_seconds,
            client=http_client,
        ),
        http_client,
    )
