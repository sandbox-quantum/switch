"""The provider list and each provider's advanced-configuration fields,
mounted at `/management` beside the agent-management routes but served
whether or not agent management is on: Switch Console builds the
advanced-configuration form of every agent from them, the ones it runs
itself as well as managed ones."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from switch_core.config import SwitchConfig
from switch_core.db.models import User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config
from switch_core.providers.schema import advanced_config_schema, providers_schema

router = APIRouter(prefix="/management")

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("/providers")
async def list_providers(
    user: CurrentUser, config: Annotated[SwitchConfig, Depends(get_config)]
) -> dict[str, Any]:
    """Every provider a new definition can name on this server, each with its
    label and its advanced-configuration fields, in the order a client offers
    them."""
    return providers_schema(config.feature_flags)


@router.get("/advanced-config")
async def get_advanced_config(user: CurrentUser) -> dict[str, Any]:
    """Each provider's advanced-configuration fields, which a definition's
    `advanced_config` is checked against."""
    return advanced_config_schema()
