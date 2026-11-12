"""Which Switch Trust settings check a workspace's messages.

Today one row covers every workspace on the deployment. Settings kept per
organization would answer here instead, so a reader that asks for the bound
workspace's policy through this does not change when they do.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TrustSettings
from switch_core.db.stores.trust_settings_store import TrustSettingsStore


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
