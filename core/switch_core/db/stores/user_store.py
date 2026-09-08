from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import OidcIdentity, User


class OidcIdentityConflictError(Exception):
    """An unverified OIDC login's email already belongs to a different account.

    Raised instead of silently linking the IdP identity to a pre-existing
    account: an unverified email is attacker-controllable, so trusting it to
    pick an account is an account-takeover vector. A verified email links
    instead — see ``get_or_create_oidc_user``.
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
        """Find the user linked to this IdP identity by its immutable (iss, sub)."""
        result = await session.execute(
            select(User)
            .join(OidcIdentity, OidcIdentity.user_id == User.id)
            .where(OidcIdentity.iss == iss, OidcIdentity.sub == sub)
        )
        return result.scalar_one_or_none()

    async def get_or_create_oidc_user(
        self,
        session: AsyncSession,
        *,
        iss: str,
        email: str,
        name: str,
        sub: str,
        email_verified: bool,
    ) -> User:
        """Resolve an OIDC identity to a gateway user, provisioning on first
        login (JIT).

        Accounts are keyed on verified email, not on login method: a subject
        already linked to a user is returned as-is (looked up on the
        immutable ``(iss, sub)`` pair, never the mutable email). Otherwise, a
        *verified* email that matches an existing account links this identity
        to it — one user can hold several linked identities — so someone who
        signed up with a password and later signs in with an IdP sharing that
        email lands in the same account instead of a second one.

        An unverified email must never pick an existing account: that is an
        attacker-controllable claim, so a collision with a pre-existing
        account is refused rather than linked. A brand-new email — verified
        or not — provisions a fresh ``user`` (no password hash).
        """
        user = await self.get_by_oidc_identity(session, iss=iss, sub=sub)
        if user is not None:
            return user

        existing = await self.get_by_email(session, email)
        if existing is not None:
            if not email_verified:
                raise OidcIdentityConflictError(
                    f"An account with email {email!r} already exists and this "
                    "identity's email is not verified."
                )
            await self._link_identity(session, user=existing, iss=iss, sub=sub)
            return existing

        user = User(name=name, email=email, role="user", password_hash=None)
        await self.create(session, user)
        await self._link_identity(session, user=user, iss=iss, sub=sub)
        return user

    async def _link_identity(
        self, session: AsyncSession, *, user: User, iss: str, sub: str
    ) -> None:
        session.add(OidcIdentity(user_id=user.id, iss=iss, sub=sub))
        await session.flush()

    async def get_all(self, session: AsyncSession) -> list[User]:
        result = await session.execute(select(User))
        return list(result.scalars().all())
