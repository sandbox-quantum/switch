from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import TenantMember


class TenantMembershipError(Exception):
    """A user has zero, or more than one, tenant memberships.

    Phase 1 has exactly one tenant, so exactly one membership row is the only
    correct state: zero means the user was never enrolled (a bug in whatever
    created the account), and more than one is Phase 2's tenant-switching
    shape arriving early. Either way this must not be resolved by picking
    one — see `docs/old/multi-tenancy-phase1-db.md`, "Setting the tenant".

    Raised, not returned, but not left to reach the client either: the gateway
    turns it into a 403 naming no user id (`gateway/auth.py`), so a broken
    account gets an answer an operator can act on instead of a bare 500.
    """


class TenantMemberStore:
    """Reads memberships. Deliberately does not write them.

    There was a `create` here and nothing ever called it. Membership is not a
    thing code decides to write on its own: it is written by, and only by, the
    paths that produce or repair an account, so that "every account has exactly
    one" holds by construction rather than by everyone remembering. That write
    is `UserStore.ensure_membership`, which is idempotent and derives the role
    from the user. A second, unguarded way in — taking `tenant_id`, `user_id`
    and `role` from whatever the caller felt like — is how an account ends up
    with two, and `get_sole_tenant_id` below refuses to pick between two just
    as firmly as it refuses to invent one out of zero.
    """

    async def get_sole_tenant_id(self, session: AsyncSession, user_id: str) -> str:
        """The one tenant this user belongs to, raising if that isn't true.

        Must run on a session with no tenant bound yet — this *is* how the
        tenant gets found, so it cannot presuppose one. `gateway/auth.py`
        opens a short-lived session for exactly this and closes it before the
        request's own session is touched.
        """
        result = await session.execute(
            select(TenantMember.tenant_id).where(TenantMember.user_id == user_id)
        )
        tenant_ids = result.scalars().all()
        if len(tenant_ids) != 1:
            raise TenantMembershipError(
                f"user {user_id} has {len(tenant_ids)} tenant memberships; "
                "expected exactly 1"
            )
        return tenant_ids[0]
