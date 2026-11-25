"""The license someone accepts before creating an organization.

Set `GATEWAY_LICENSE_VERSION` and creating an organization (`POST
/organizations`) is refused, 409, until the caller has accepted that
version (`POST /auth/license`); `GET /auth/session` says which version is
waiting (`license_to_accept`), so the dashboard asks for it first. Each
acceptance is kept: who, which version and when (`license_acceptances`). A
new version is asked of everyone who creates an organization after it is
set. Unset, nothing is asked. Joining an organization someone else created
asks nothing: the license is the creator's, for the organization.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.config import SwitchConfig
from switch_core.db.models import LicenseAcceptance

LICENSE_FIRST = "Accept the Switch license before setting up an organization."


async def license_to_accept(
    session: AsyncSession, config: SwitchConfig, user_id: str
) -> str | None:
    """The version of the license `user_id` has yet to accept, or None when
    none is asked for or they have accepted it."""
    version = config.gateway_license_version
    if version is None:
        return None
    accepted = await session.scalar(
        select(LicenseAcceptance.version).where(
            LicenseAcceptance.user_id == user_id, LicenseAcceptance.version == version
        )
    )
    return None if accepted is not None else version


async def accept_license(
    session: AsyncSession, user_id: str, version: str, now: datetime
) -> None:
    """Record that `user_id` accepted `version`, keeping the first time they
    did."""
    await session.execute(
        insert(LicenseAcceptance)
        .values(user_id=user_id, version=version, accepted_at=now)
        .on_conflict_do_nothing(index_elements=["user_id", "version"])
    )
