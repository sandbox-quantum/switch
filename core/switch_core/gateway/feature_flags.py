from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from switch_core.config import SwitchConfig
from switch_core.gateway.auth import get_authenticated_user_id
from switch_core.gateway.dependencies import get_config
from switch_core.gateway.schemas import FeatureFlagsResponse, FeatureFlagState

router = APIRouter()


@router.get("/feature-flags")
async def list_feature_flags(
    _user_id: Annotated[str, Depends(get_authenticated_user_id)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> FeatureFlagsResponse:
    """Every known flag and whether this deployment turned it on.

    Flags belong to the deployment, not a workspace, so any signed-in caller may
    read them before choosing a workspace. They are set at deploy time and
    cannot be changed here.
    """
    return FeatureFlagsResponse(
        flags=[
            FeatureFlagState(key=key, enabled=enabled)
            for key, enabled in config.feature_flags.items()
        ]
    )
