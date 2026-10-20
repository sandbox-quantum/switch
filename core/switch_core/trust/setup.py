"""Building the Switch Trust client at boot.

One function, so `main.py` does not have to know the difference between a
deployment with guardrails configured and one without — it asks for a client
and gets one either way, and whether it actually checks anything is decided
per call from the `trust_settings` row (see `trust/client.py`), not at boot.
"""

from __future__ import annotations

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.trust.client import DynamicTrustClient, TrustClient


def build_trust_client(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
) -> tuple[TrustClient, httpx.AsyncClient]:
    """The trust client, and its HTTP client so `main` can close it."""
    http_client = httpx.AsyncClient()
    client = DynamicTrustClient(
        session_factory=session_factory,
        store=TrustSettingsStore(),
        keyring=config.keyring,
        client=http_client,
        timeout_seconds=config.switch_trust_timeout_seconds,
    )
    return client, http_client
