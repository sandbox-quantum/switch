from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from switch_core.config import SwitchConfig
from switch_core.feature_flags import V2_ONLY_FLAGS
from switch_core.gateway.auth import get_authenticated_user_id
from switch_core.gateway.dependencies import get_config
from switch_core.gateway.schemas import FeatureFlagsResponse, FeatureFlagState
from switch_core.hosted_v2 import HOSTED_V2_FLAG, hosted_v2_on

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
    v2 = hosted_v2_on(config)
    return FeatureFlagsResponse(
        flags=[
            FeatureFlagState(key=key, enabled=enabled)
            for key, enabled in config.feature_flags.items()
            # v2's own flags are left out with v2 off, so the list is
            # upstream's exactly.
            if v2 or key not in V2_ONLY_FLAGS
        ]
        # The v1/v2 switch, derived from HOSTED_BOX_PROVISIONING (never set
        # here): listed only when on; a client reads it missing as off.
        + ([FeatureFlagState(key=HOSTED_V2_FLAG, enabled=True)] if v2 else [])
    )
