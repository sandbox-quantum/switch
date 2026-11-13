"""Which Switch Trust settings check a workspace's messages.

Today one row covers every workspace on the deployment. Settings kept per
organization would answer here instead, so a reader that asks for the bound
workspace's policy through this does not change when they do.
"""

from __future__ import annotations

from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TrustSettings
from switch_core.db.stores.trust_settings_store import TrustSettingsStore

# Where Switch checks messages until an operator saves another endpoint.
DEFAULT_TRUST_ENDPOINT = "https://api.switchagents.ai"

# Where a policy checked through the default endpoint is shown. A policy on
# any other endpoint is on a Switch Trust this cannot link into.
_POLICY_URL = "https://app.switchagents.ai/settings/guardrail-policies/{}"


async def trust_settings_for_workspace(session: AsyncSession) -> TrustSettings | None:
    """The settings that check the bound workspace's messages, None when none
    are saved. Saved settings check nothing until they hold both a policy and
    an API key (`checks_messages`)."""
    return await TrustSettingsStore().get(session)


def checks_messages(settings: TrustSettings | None) -> bool:
    """Whether `settings` check anything, the way
    `trust.client.DynamicTrustClient` decides it."""
    return settings is not None and bool(
        settings.policy_id and settings.api_key_encrypted
    )


def policy_url(endpoint: str, policy_id: str) -> str | None:
    """Where `policy_id` is shown on Switch Trust, None when `endpoint` is not
    the one Switch knows the app of."""
    if endpoint.rstrip("/") != DEFAULT_TRUST_ENDPOINT:
        return None
    return _POLICY_URL.format(quote(policy_id, safe=""))
