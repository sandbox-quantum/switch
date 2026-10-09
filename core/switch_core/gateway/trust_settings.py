"""Switch Trust's one server-global settings row — deployment-operator only.

Not tenant-scoped: `require_admin` (`users.role == "admin"`), not
`require_tenant_admin`, gates every route here, since one guardrails policy
covers the whole deployment rather than one tenant's traffic.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import TrustSettings, User
from switch_core.db.stores.trust_settings_store import TrustSettingsStore
from switch_core.gateway.auth import require_admin
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.schemas import (
    TrustSettingsResponse,
    TrustSettingsUpdateRequest,
)

router = APIRouter()

# Matches the previous env-var default (`SwitchConfig.switch_trust_endpoint`,
# since removed) — shown until an operator saves their own.
DEFAULT_TRUST_ENDPOINT = "https://api.switchagents.ai"


def _to_response(
    settings: TrustSettings | None, config: SwitchConfig
) -> TrustSettingsResponse:
    if settings is None:
        return TrustSettingsResponse(
            endpoint=DEFAULT_TRUST_ENDPOINT,
            policy_id=None,
            has_api_key=False,
            api_key_last4=None,
            enabled=False,
        )
    api_key_last4 = (
        config.keyring.decrypt(settings.api_key_encrypted)[-4:]
        if settings.api_key_encrypted
        else None
    )
    return TrustSettingsResponse(
        endpoint=settings.endpoint,
        policy_id=settings.policy_id,
        has_api_key=settings.api_key_encrypted is not None,
        api_key_last4=api_key_last4,
        enabled=bool(settings.policy_id and settings.api_key_encrypted),
    )


@router.get("/trust-settings")
async def get_trust_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    _admin: Annotated[User, Depends(require_admin)],
) -> TrustSettingsResponse:
    settings = await TrustSettingsStore().get(session)
    return _to_response(settings, config)


@router.put("/trust-settings")
async def update_trust_settings(
    req: TrustSettingsUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    _admin: Annotated[User, Depends(require_admin)],
) -> TrustSettingsResponse:
    """`req.api_key` omitted leaves whatever key is already stored untouched,
    so changing the endpoint or policy id doesn't force re-entering it."""
    store = TrustSettingsStore()
    existing = await store.get(session)
    api_key_encrypted = existing.api_key_encrypted if existing else None
    if req.api_key is not None:
        api_key_encrypted = config.keyring.encrypt(req.api_key)
    settings = await store.upsert(
        session,
        endpoint=req.endpoint,
        policy_id=req.policy_id,
        api_key_encrypted=api_key_encrypted,
    )
    await session.commit()
    return _to_response(settings, config)


@router.delete("/trust-settings")
async def delete_trust_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    _admin: Annotated[User, Depends(require_admin)],
) -> TrustSettingsResponse:
    await TrustSettingsStore().clear(session)
    await session.commit()
    return _to_response(None, config)
