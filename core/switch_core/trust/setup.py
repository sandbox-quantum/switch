"""Building the Switch Trust client at boot.

One function, so `main.py` does not have to know the difference between a
deployment with guardrails configured and one without — it asks for a client
and gets one either way.
"""

from __future__ import annotations

import logging

import httpx

from switch_core.config import SwitchConfig
from switch_core.trust.client import HttpTrustClient, NullTrustClient, TrustClient

logger = logging.getLogger(__name__)


def build_trust_client(
    config: SwitchConfig,
) -> tuple[TrustClient, httpx.AsyncClient | None]:
    """The trust client, and its HTTP client so `main` can close it.

    Returns a `NullTrustClient` (no request ever made) unless both
    `SWITCH_TRUST_API_KEY` and `SWITCH_TRUST_POLICY_ID` are set.
    """
    api_key = config.switch_trust_api_key
    policy_id = config.switch_trust_policy_id
    if not api_key or not policy_id:
        logger.info(
            "Switch Trust is off; messages are not checked before sending. Set "
            "SWITCH_TRUST_API_KEY and SWITCH_TRUST_POLICY_ID to turn it on."
        )
        return NullTrustClient(), None

    http_client = httpx.AsyncClient()
    client = HttpTrustClient(
        base_url=config.switch_trust_endpoint,
        api_key=api_key,
        policy_id=policy_id,
        timeout_seconds=config.switch_trust_timeout_seconds,
        client=http_client,
    )
    logger.info(
        "Switch Trust is ON: messages are checked against %s before sending.",
        config.switch_trust_endpoint,
    )
    return client, http_client
