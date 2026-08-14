from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from switch_core.db.models import User
from switch_core.engagements_yaml import (
    EngagementProvisionResult,
    EngagementYamlService,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_engagement_yaml_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/from-yaml", status_code=201)
async def create_engagement_from_yaml(
    request: Request,
    engagements: Annotated[EngagementYamlService, Depends(get_engagement_yaml_service)],
    user: Annotated[User, Depends(get_current_user)],
) -> EngagementProvisionResult:
    """Provision a multi-room engagement (a room group + rooms + links) from a
    YAML spec. The body is the raw YAML text. Agent / bridge names are
    validated up front (fail-loud), then the group and rooms are created and
    links attached best-effort — per-room attachment and link failures are
    surfaced in the result rather than dropped."""
    text = (await request.body()).decode("utf-8")
    try:
        spec = engagements.parse(text)
        return await engagements.provision(
            spec, user_id=user.id, is_admin=user.role == "admin"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
