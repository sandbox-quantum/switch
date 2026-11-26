"""The license Switch is offered under, and who has accepted it.

The text is the project's LICENSE file, read once at startup from beside
`pyproject.toml` (`core/LICENSE` links to the repository's; the server image
copies it in), so a server without it does not start. Its version is a digest
of that text: a changed license has a new version, and everyone is asked to
accept it again.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session, get_user_store

router = APIRouter()

LICENSE_TEXT = (Path(__file__).resolve().parents[2] / "LICENSE").read_text()
LICENSE_VERSION = hashlib.sha256(LICENSE_TEXT.encode()).hexdigest()[:16]


class LicenseView(BaseModel):
    version: str
    text: str


class LicenseAcceptanceView(BaseModel):
    version: str
    accepted_version: str | None
    accepted_at: datetime | None


class AcceptLicenseRequest(BaseModel):
    version: str


def _acceptance(user: User) -> LicenseAcceptanceView:
    return LicenseAcceptanceView(
        version=LICENSE_VERSION,
        accepted_version=user.license_accepted_version,
        accepted_at=user.license_accepted_at,
    )


@router.get("/license")
async def get_license() -> LicenseView:
    # Unauthenticated: the sign-up page links to it before any account exists.
    return LicenseView(version=LICENSE_VERSION, text=LICENSE_TEXT)


@router.get("/auth/me/license")
async def my_license_acceptance(
    user: Annotated[User, Depends(get_current_user)],
) -> LicenseAcceptanceView:
    """The current license's version, and the one the signed-in person last
    accepted and when, if they have."""
    return _acceptance(user)


@router.put("/auth/me/license")
async def accept_license(
    req: AcceptLicenseRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    user: Annotated[User, Depends(get_current_user)],
) -> LicenseAcceptanceView:
    """Record that the signed-in person accepted the license they were shown,
    named by its version, which must be the current one."""
    if req.version != LICENSE_VERSION:
        raise HTTPException(
            status_code=409,
            detail="The license has changed since it was shown. Read it again before accepting.",
        )
    await user_store.record_license_acceptance(session, user, LICENSE_VERSION)
    await session.commit()
    return _acceptance(user)
