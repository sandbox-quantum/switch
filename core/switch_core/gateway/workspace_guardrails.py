"""The Switch Trust policy that checks the bound workspace's messages, for
anyone in it to read: which policy, and where to see it. Changing it is not
here (`trust_settings.py`)."""

from __future__ import annotations

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.schemas import WorkspaceGuardrails
from switch_core.gateway.trust_settings import DEFAULT_TRUST_ENDPOINT
from switch_core.trust.workspace_policy import (
    checks_messages,
    trust_settings_for_workspace,
)

router = APIRouter()

# Where a policy checked through the default endpoint is shown. A policy on
# any other endpoint is on a Switch Trust this cannot link into.
SWITCH_TRUST_POLICY_URL = "https://app.switchagents.ai/settings/guardrail-policies/{}"


@router.get("/workspace/guardrails")
async def get_workspace_guardrails(
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(get_current_user)],
) -> WorkspaceGuardrails:
    settings = await trust_settings_for_workspace(session)
    if settings is None or not checks_messages(settings):
        return WorkspaceGuardrails(checking=False, policy_id=None, policy_url=None)
    assert settings.policy_id is not None  # `checks_messages` said so.
    on_default = settings.endpoint.rstrip("/") == DEFAULT_TRUST_ENDPOINT
    return WorkspaceGuardrails(
        checking=True,
        policy_id=settings.policy_id,
        policy_url=SWITCH_TRUST_POLICY_URL.format(quote(settings.policy_id, safe=""))
        if on_default
        else None,
    )
