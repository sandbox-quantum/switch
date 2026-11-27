"""The license Switch is offered under, and who has accepted it.

The text is the copy of the repository's LICENSE shipped inside the
`switch_core` package (`switch_core/LICENSE`, kept identical by a test), so
every install has it: a wheel, the server image and an editable checkout
alike. It is read on first use, and a server missing it still starts: only
the license routes fail, with a 503 that names the problem. Its version is a
digest of that text: a changed license has a new version, and everyone is
asked to accept it again.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from functools import cache
from importlib.resources import files
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.hosted_machines import hosted_settings, warm_after_sign_in
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import current_tenant_id

logger = logging.getLogger(__name__)

router = APIRouter()


class LicenseView(BaseModel):
    version: str
    text: str


@cache
def _read_license() -> LicenseView:
    text = files("switch_core").joinpath("LICENSE").read_text(encoding="utf-8")
    return LicenseView(
        version=hashlib.sha256(text.encode()).hexdigest()[:16], text=text
    )


def current_license() -> LicenseView:
    """The license text and its version; 503 when this install lacks it."""
    try:
        return _read_license()
    except OSError as exc:
        logger.error("The license file shipped with switch_core can't be read: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"This server can't read the license it is offered under ({exc}). "
            "Its install is missing switch_core/LICENSE.",
        ) from exc


class LicenseAcceptanceView(BaseModel):
    version: str
    accepted_version: str | None
    accepted_at: datetime | None


class AcceptLicenseRequest(BaseModel):
    version: str


def _acceptance(user: User) -> LicenseAcceptanceView:
    return LicenseAcceptanceView(
        version=current_license().version,
        accepted_version=user.license_accepted_version,
        accepted_at=user.license_accepted_at,
    )


@router.get("/license")
async def get_license() -> LicenseView:
    # Unauthenticated: the sign-up page links to it before any account exists.
    return current_license()


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
    background: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_session)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
    user_store: Annotated[UserStore, Depends(get_user_store)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    hosted: Annotated[HostedControllerSettings | None, Depends(hosted_settings)],
    user: Annotated[User, Depends(get_current_user)],
) -> LicenseAcceptanceView:
    """Record that the signed-in person accepted the license they were shown,
    named by its version, which must be the current one. Accepting is the last
    onboarding step, so it also starts their Switch Cloud machine in the bound
    workspace, which then warms while they get started."""
    version = current_license().version
    if req.version != version:
        raise HTTPException(
            status_code=409,
            detail="The license has changed since it was shown. Read it again before accepting.",
        )
    await user_store.record_license_acceptance(session, user, version)
    await session.commit()
    background.add_task(
        warm_after_sign_in,
        session_factory,
        user.id,
        current_tenant_id(),
        config,
        hosted,
    )
    return _acceptance(user)
