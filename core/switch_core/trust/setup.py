"""Building the Switch Trust client and the agent inventory sync at boot.

One function, so `main.py` does not have to know the difference between a
deployment with guardrails configured and one without — it asks for a client
and gets one either way, and whether it actually checks anything is decided
per call from the `trust_settings` row (see `trust/client.py`), not at boot.
The inventory sync (`trust/inventory.py`) decides the same way on each pass.

Both name this deployment by `deployment_identity.client_id`, a random id the
migrations seed once and nothing changes, because it is part of every agent's
fingerprint in Switch Trust.
"""

from __future__ import annotations

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.telemetry.deployment import load_deployment_identity
from switch_core.trust.client import DynamicTrustClient
from switch_core.trust.inventory import InventorySync, ServerIdentity
from switch_core.version import switch_core_version


async def build_trust_client(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
) -> tuple[DynamicTrustClient, InventorySync, httpx.AsyncClient]:
    """The trust client, the inventory sync, and the HTTP client both use, so
    `main` can close it."""
    server_id, _installed_at = await load_deployment_identity(session_factory)
    http_client = httpx.AsyncClient()
    store = TrustSettingsStore()
    client = DynamicTrustClient(
        session_factory=session_factory,
        store=store,
        keyring=config.keyring,
        client=http_client,
        timeout_seconds=config.switch_trust_timeout_seconds,
        server_id=server_id,
    )
    inventory = InventorySync(
        session_factory=session_factory,
        store=store,
        keyring=config.keyring,
        client=http_client,
        server=ServerIdentity(
            id=server_id,
            name=config.id_server_name,
            version=switch_core_version(),
        ),
    )
    return client, inventory, http_client
