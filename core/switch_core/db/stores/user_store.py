from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User


class OidcIdentityConflictError(Exception):
    """An OIDC login's email already belongs to a different local account.

    Raised instead of silently linking the IdP identity to a pre-existing
    account: auto-linking by email is an account-takeover vector.
    """


class UserStore:
    async def create(self, session: AsyncSession, user: User) -> None:
        session.add(user)
        await session.flush()

    async def get(self, session: AsyncSession, user_id: str) -> User | None:
        return await session.get(User, user_id)

    async def get_by_email(self, session: AsyncSession, email: str) -> User | None:
        result = await session.execute(select(User).where(User.email == email))
        return result.scalar_one_or_none()

    async def get_by_oidc_identity(
        self, session: AsyncSession, *, iss: str, sub: str
    ) -> User | None:
        """Find the user bound to this IdP identity by its immutable (iss, sub).

        Legacy rows (provisioned before iss was stored) carry only ``oidc_sub``;
        those match on sub alone and get their ``oidc_iss`` backfilled by the
        caller. ``sub`` is unique per issuer, so matching on it is safe.
        """
        result = await session.execute(
            select(User).where(User.metadata_["oidc_sub"].astext == sub)
        )
        for user in result.scalars().all():
            stored_iss = (user.metadata_ or {}).get("oidc_iss")
            if stored_iss is None or stored_iss == iss:
                return user
        return None

    async def get_or_create_oidc_user(
        self,
        session: AsyncSession,
        *,
        iss: str,
        email: str,
        name: str,
        sub: str,
    ) -> User:
        """Resolve an OIDC identity to a gateway user, provisioning on first
        login (JIT).

        Identity is bound to the immutable ``(iss, sub)`` pair, never to the
        mutable email: an existing user is only returned when its stored IdP
        subject matches. A brand-new subject provisions a fresh ``user`` (no
        password hash). If the email is already taken by a different local
        account (a password user, or a different IdP subject), we refuse rather
        than link, so a token bearing someone else's email cannot take over
        their account (including the seeded admin).
        """
        user = await self.get_by_oidc_identity(session, iss=iss, sub=sub)
        if user is not None:
            meta = dict(user.metadata_ or {})
            if meta.get("oidc_iss") != iss:
                meta["oidc_iss"] = iss
                user.metadata_ = meta
                await session.flush()
            return user

        if await self.get_by_email(session, email) is not None:
            raise OidcIdentityConflictError(
                f"An account with email {email!r} already exists and is not "
                "linked to this identity."
            )

        user = User(
            name=name,
            email=email,
            role="user",
            password_hash=None,
            metadata_={"oidc_iss": iss, "oidc_sub": sub},
        )
        await self.create(session, user)
        return user

    async def get_all(self, session: AsyncSession) -> list[User]:
        result = await session.execute(select(User))
        return list(result.scalars().all())
