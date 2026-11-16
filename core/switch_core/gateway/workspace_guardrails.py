"""The Switch Trust policy that checks the bound workspace's messages, for
anyone in it to read: which policy, and where to see it. Its organization's
admins connect it (`organization_guardrails.py`)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.schemas import WorkspaceGuardrails
from switch_core.trust.workspace_policy import (
    checks_messages,
    policy_url,
    trust_settings_for_workspace,
)

router = APIRouter()


@router.get("/workspace/guardrails")
async def get_workspace_guardrails(
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(get_current_user)],
) -> WorkspaceGuardrails:
    settings = await trust_settings_for_workspace(session)
    if settings is None or not checks_messages(settings):
        return WorkspaceGuardrails(
            checking=False, policy_id=None, policy_name=None, policy_url=None
        )
    return WorkspaceGuardrails(
        checking=True,
        policy_id=settings.policy_id,
        policy_name=settings.policy_name,
        policy_url=policy_url(settings.endpoint, settings.policy_id),
    )
