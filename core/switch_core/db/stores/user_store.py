from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.authz import administers_tenant
from switch_core.db.models import (
    OidcIdentity,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.tenant_context import current_tenant_id

logger = logging.getLogger(__name__)

# One retry: after a unique-constraint conflict, the row the other transaction
# just committed is visible to the retry's lookups, so a second collision
# would mean something other than the race this exists for.
_MAX_ATTEMPTS = 2


class OidcIdentityConflictError(Exception):
    """An unverified OIDC login's email already belongs to a different account.

    Raised instead of silently linking the IdP identity to a pre-existing
    account: an unverified email is attacker-controllable, so trusting it to
    pick an account is an account-takeover vector. A verified email links
    instead — see ``get_or_create_oidc_user``.

    A rejected security decision, not a retry-able condition — distinct from
    ``OidcIdentityRaceError``, so an operator watching for the latter is not
    drowned in the former (or vice versa).
    """


class OidcIdentityRaceError(Exception):
    """Two logins raced to provision or link the same identity or email twice
    in a row.

    Transient contention, not a security decision: the caller should retry
    the login rather than treat this as an attack signal. Kept separate from
    ``OidcIdentityConflictError`` so the two can be told apart in logs and
    given different HTTP treatment at the callback.
    """


class UserStore:
    async def create(self, session: AsyncSession, user: User) -> None:
        """Create the user, and the membership that lets them ever sign in.

        Tenant resolution (`gateway/auth.py`) raises rather than guessing when
        a user has no membership, so every path that creates a user — this
        one, reached by the admin "create user" endpoint, JIT OIDC
        provisioning, and startup admin seeding — must leave exactly one
        `tenant_members` row behind, or that user's first login cannot be
        placed in a tenant at all.
        """
        session.add(user)
        await session.flush()
        await self.ensure_membership(session, user)

    async def ensure_membership(self, session: AsyncSession, user: User) -> bool:
        """Give `user` a membership if they have none; leave any they have.

        Returns whether one was written, so a repair path can say it repaired
        something instead of logging on every boot.

        Called from every path that can produce, or inherit, a user who would
        otherwise have zero: creation, linking an identity to an account that
        predates memberships existing, and the startup admin seeding
        (`main.py`), which reaches accounts none of the others do. Idempotent
        because most of those run against accounts that already have one, and
        adding a second would be worse than adding none — resolution refuses
        to pick between two.

        Public for the sake of that last caller. An account with no membership
        cannot sign in at all (`gateway/auth.py` answers 403), and until this
        was reachable from seeding, the only thing that ever repaired one was
        an OIDC login — so a password-only account in that state had no remedy
        inside the product and needed direct SQL.

        Joins the tenant bound to the caller's context, so an admin creating a
        user joins them to their own tenant. There is no fallback: `tenant_id`
        is not nullable and nothing else in this schema fills it in, so an
        unbound caller would otherwise get whichever tenant this function
        happened to name — the same silent write into a real tenant that
        `require_tenant_id` exists to refuse, and this is the one scoped write
        the model default cannot cover because `TenantMember` is addressed by
        its whole primary key. The seeding paths that legitimately run with
        nothing bound name tenant zero themselves (`main.py`,
        `gateway/oidc_routes.py`).

        The role mirrors the migration's own mapping for pre-existing users:
        `owner` for the global admin role, `member` otherwise.
        """
        existing = await session.execute(
            select(TenantMember.tenant_id).where(TenantMember.user_id == user.id)
        )
        if existing.first() is not None:
            return False
        session.add(
            TenantMember(
                tenant_id=require_tenant_id(),
                user_id=user.id,
                role="owner" if user.role == "admin" else "member",
            )
        )
        await session.flush()
        return True

    async def get(self, session: AsyncSession, user_id: str) -> User | None:
        return await session.get(User, user_id)

    async def exists(self, session: AsyncSession, user_id: str) -> bool:
        """Whether this id names a real account, without loading the row.

        Tenant resolution needs the answer on a session it closes immediately
        (`gateway/auth.py`), and a `User` loaded there would be attached to a
        session nobody can commit — the exact shape of bug this replaced. It
        needs no attribute of the row, only that there is one.
        """
        result = await session.execute(select(User.id).where(User.id == user_id))
        return result.first() is not None

    async def get_by_email(self, session: AsyncSession, email: str) -> User | None:
        """Case-insensitive: an IdP and a person typing a password don't
        reliably agree on the casing of the same mailbox, and accounts must
        be the same account regardless. Backed by ``ix_users_email_lower``.

        ``users.email`` is still case-sensitively unique, so two rows
        differing only in case can already exist from before this method
        compared case-insensitively. A login must not turn that into a 500;
        neither should it silently guess between two real accounts — one of
        which could be an admin — since a random pick that happens to change
        between calls is a worse failure mode than a wrong-but-stable one, and
        a wrong one nobody hears about is worse than either. So the pick is
        made deterministic — ordered by ``id``, which is an arbitrary but
        stable tiebreak, not a claim that the lower id is the "real" or
        original account — and the ambiguity itself is logged loudly so it
        gets noticed and cleaned up rather than repeating unnoticed on every
        login.
        """
        result = await session.execute(
            select(User)
            .where(func.lower(User.email) == email.lower())
            .order_by(User.id)
        )
        users = result.scalars().all()
        if len(users) > 1:
            logger.error(
                "Multiple users share email %r case-insensitively (ids: %s); "
                "returning %s (lowest id, an arbitrary but stable pick). This "
                "is pre-existing duplicate data, not something this login "
                "caused — merge or rename the extra account(s).",
                email,
                [u.id for u in users],
                users[0].id,
            )
        return users[0] if users else None

    async def get_by_oidc_identity(
        self, session: AsyncSession, *, iss: str, sub: str
    ) -> User | None:
        """Find the user linked to this IdP identity by its immutable (iss, sub).

        A row with no stored issuer predates CHOO-2624 tracking one at all; it
        matches on ``sub`` alone and has its issuer backfilled here, same as
        this identity did before it had its own table.
        ``ix_oidc_identities_sub_null_iss`` guarantees at most one such row per
        ``sub``, so this is a well-defined lookup and not a guess between rows.
        """
        result = await session.execute(
            select(User)
            .join(OidcIdentity, OidcIdentity.user_id == User.id)
            .where(OidcIdentity.iss == iss, OidcIdentity.sub == sub)
        )
        user = result.scalar_one_or_none()
        if user is not None:
            return user

        legacy = await session.execute(
            select(OidcIdentity).where(
                OidcIdentity.iss.is_(None), OidcIdentity.sub == sub
            )
        )
        identity = legacy.scalar_one_or_none()
        if identity is None:
            return None
        identity.iss = iss
        await session.flush()
        return await session.get(User, identity.user_id)

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

        An unverified email must never pick an *existing, different* account:
        that is an attacker-controllable claim, so a collision is refused
        rather than linked. A brand-new email — verified or not — provisions
        a fresh ``user`` (no password hash), stored lower-cased so accounts
        this method creates don't add new case variants of their own; this
        does not touch the casing of any pre-existing row. This guarantee
        does not extend to a legacy identity already linked before issuers
        were tracked (see ``get_by_oidc_identity``): that keeps resolving,
        and backfilling its issuer, purely by matching ``sub`` — without
        consulting email, ``email_verified``, or even the issuer on the
        incoming claim — exactly as it did before this identity had its own
        table.

        Two logins racing to provision or link the same identity or the same
        new email hit a unique-constraint conflict inside a savepoint rather
        than either one silently overwriting the other or losing the rest of
        the caller's transaction; this retries once against whichever row
        won, so the raced request resolves to that row instead of a 500.
        """
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            user = await self.get_by_oidc_identity(session, iss=iss, sub=sub)
            if user is not None:
                return user

            existing = await self.get_by_email(session, email)
            if existing is not None:
                if not email_verified:
                    raise OidcIdentityConflictError(
                        f"An account with email {email!r} already exists and "
                        "this identity's email is not verified."
                    )
                try:
                    async with session.begin_nested():
                        await self._link_identity(
                            session, user=existing, iss=iss, sub=sub
                        )
                except IntegrityError:
                    self._raise_if_exhausted(attempt)
                    continue
                return existing

            user = User(name=name, email=email.lower(), role="user", password_hash=None)
            try:
                async with session.begin_nested():
                    await self.create(session, user)
                    await self._link_identity(session, user=user, iss=iss, sub=sub)
            except IntegrityError:
                self._raise_if_exhausted(attempt)
                continue
            return user

        raise AssertionError("unreachable: the loop above always returns or raises")

    def _raise_if_exhausted(self, attempt: int) -> None:
        # The savepoint above already rolled back just the failed write, not
        # the caller's whole transaction, so nothing to undo here.
        if attempt == _MAX_ATTEMPTS:
            raise OidcIdentityRaceError(
                "OIDC identity resolution raced twice in a row; refusing to "
                "guess a winner a third time."
            )

    async def _link_identity(
        self, session: AsyncSession, *, user: User, iss: str, sub: str
    ) -> None:
        session.add(OidcIdentity(user_id=user.id, iss=iss, sub=sub))
        await session.flush()
        # The most security-relevant event this store performs: it decides
        # which account an external identity provider can now sign in as.
        # Logged only after the flush succeeds, so a racer that loses to a
        # concurrent write (see get_or_create_oidc_user) never logs a link
        # that didn't happen.
        logger.warning(
            "Linking OIDC identity (iss=%r, sub=%r) to user %s", iss, sub, user.id
        )
        # Linking reaches accounts this store did not create, including any
        # that predate memberships — and an account with none can never sign
        # in again. The startup admin seeding repairs the deployment's own
        # admin; this repairs anyone else who signs in through an IdP.
        await self.ensure_membership(session, user)

    async def get_all(self, session: AsyncSession) -> list[User]:
        result = await session.execute(select(User))
        return list(result.scalars().all())

    async def add_membership(
        self, session: AsyncSession, *, tenant_id: str, user_id: str, role: str
    ) -> TenantMember:
        """Insert a `role` membership for `user_id` in `tenant_id`.

        Distinct from `ensure_membership`, which derives the role from the
        caller's global bit and is a no-op when a membership already exists:
        this is the explicit write for the two places that grant a *specific*
        role by a caller's own action — creating a workspace (the creator
        becomes its `owner`) and accepting an invitation (the invited role).
        It does not check for an existing row first; a caller that needs that
        checks before calling. Kept as the one place `TenantMember` is
        constructed (`tests/switch_core/test_seed_admin_membership.py` pins
        that), so a route never writes one directly.
        """
        membership = TenantMember(tenant_id=tenant_id, user_id=user_id, role=role)
        session.add(membership)
        await session.flush()
        return membership

    async def tenant_role(
        self, session: AsyncSession, tenant_id: str, user_id: str
    ) -> str | None:
        """`user_id`'s membership role in `tenant_id`, or None if not a member.

        `TenantMember` is addressed by its whole primary key, so this is a
        plain `session.get` rather than a query — same shape as
        `ensure_membership`'s write.
        """
        membership = await session.get(TenantMember, (tenant_id, user_id))
        return membership.role if membership is not None else None

    async def list_tenant_members(
        self, session: AsyncSession
    ) -> list[tuple[User, TenantMember]]:
        """Every member of the session's bound tenant, joined with their user row.

        No `WHERE tenant_id = …` of its own: the policy on `tenant_members` is
        what narrows this, the same as `InvitationStore.list_for_tenant`.
        """
        result = await session.execute(
            select(User, TenantMember).join(
                TenantMember, TenantMember.user_id == User.id
            )
        )
        return [(row[0], row[1]) for row in result.all()]

    async def count_owners(self, session: AsyncSession) -> int:
        """How many `owner` memberships exist in the session's bound tenant.

        Backs "a workspace must always have an owner": removing or demoting a
        member is refused when they are the one row this counts.
        """
        result = await session.execute(
            select(func.count())
            .select_from(TenantMember)
            .where(TenantMember.role == "owner")
        )
        return result.scalar_one()

    async def administers(self, session: AsyncSession, user: User) -> bool:
        """Whether `user` may administer the tenant bound to `session`'s
        context — the operator bypass, or an owner/admin membership in it.

        See `authz.administers_tenant`, which this composes with a read of the
        one membership row that can answer "in *this* tenant". No tenant bound
        answers with the operator bit alone: every gateway request binds one
        by the time this is reachable, and nothing here should insist on a
        precondition that authentication already enforces.
        """
        tenant_id = current_tenant_id()
        role = (
            None
            if tenant_id is None
            else await self.tenant_role(session, tenant_id, user.id)
        )
        return administers_tenant(is_operator=user.role == "admin", tenant_role=role)
