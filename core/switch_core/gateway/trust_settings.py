"""The routes that set the one Switch Trust policy for the whole server, which
each organization now sets for itself (`gateway/organization_guardrails.py`).

Kept, answering 410 with where the setting went, for a Switch Console from
before the change: it shows the answer's message instead of a form that would
save nothing. Still the operator's alone, as they were.
"""

from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException

from switch_core.db.models import User
from switch_core.gateway.auth import require_admin

router = APIRouter()

SET_PER_ORGANIZATION = (
    "Guardrails are set for each organization now, by its organization "
    "admins, under Organization settings › Guardrails in the Switch dashboard."
)


def _gone() -> NoReturn:
    raise HTTPException(status_code=410, detail=SET_PER_ORGANIZATION)


@router.get("/trust-settings")
async def get_trust_settings(
    _admin: Annotated[User, Depends(require_admin)],
) -> None:
    _gone()


@router.put("/trust-settings")
async def update_trust_settings(
    _admin: Annotated[User, Depends(require_admin)],
) -> None:
    _gone()


@router.delete("/trust-settings")
async def delete_trust_settings(
    _admin: Annotated[User, Depends(require_admin)],
) -> None:
    _gone()
