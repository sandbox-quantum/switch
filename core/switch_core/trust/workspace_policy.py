"""Which Switch Trust settings check a workspace's messages: its
organization's (`OrganizationTrustSettings`), the same settings
`trust.client.DynamicTrustClient` checks them against.
"""

from __future__ import annotations

from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import OrganizationTrustSettings, require_tenant_id
from switch_core.db.stores.organization_trust_settings_store import (
    OrganizationTrustSettingsStore,
)

# Where Switch checks messages: every policy connected from the dashboard is
# checked here. A policy copied from the server's own setting keeps the
# endpoint that setting named.
DEFAULT_TRUST_ENDPOINT = "https://api.switchagents.ai"

# Where a policy checked through the default endpoint is shown. A policy on
# any other endpoint is on a Switch Trust this cannot link into.
_POLICY_URL = "https://app.switchagents.ai/settings/guardrail-policies/{}"


async def trust_settings_for_workspace(
    session: AsyncSession,
) -> OrganizationTrustSettings | None:
    """The settings that check the bound workspace's messages: its
    organization's, None when it connected none or the workspace belongs to
    no organization."""
    store = OrganizationTrustSettingsStore()
    organization_id = await store.organization_of(session, require_tenant_id())
    if organization_id is None:
        return None
    return await store.get(session, organization_id)


def checks_messages(settings: OrganizationTrustSettings | None) -> bool:
    """Whether `settings` check anything, the way
    `trust.client.DynamicTrustClient` decides it: every connected policy
    does."""
    return settings is not None


def policy_url(endpoint: str, policy_id: str) -> str | None:
    """Where `policy_id` is shown on Switch Trust, None when `endpoint` is not
    the one Switch knows the app of."""
    if endpoint.rstrip("/") != DEFAULT_TRUST_ENDPOINT:
        return None
    return _POLICY_URL.format(quote(policy_id, safe=""))
