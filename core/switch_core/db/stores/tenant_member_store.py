from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.tenant_lookup import tenants_of_user


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

    async def get_sole_tenant_id(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        user_id: str,
    ) -> str:
        """The one tenant this user belongs to, raising if that isn't true.

        Takes the factory rather than a session, unlike every other store
        method here, and the difference is the point: `tenant_members` is a
        scoped table, so a session cannot read the row that would tell it what
        to be scoped to. This goes through `tenants_of_user`, one of the eight
        `SECURITY DEFINER` lookups that make up the whole exemption from
        row-level security (`db/tenant_lookup.py`), which opens a session of
        its own with nothing bound and answers with tenant ids and nothing
        else.

        It used to run a plain `select` on a session the caller opened and
        left unbound. That worked only because every environment connected as
        the tables' owner; under the restricted runtime role it is one of the
        reads the policy refuses, and every gateway login failed on it.
        """
        tenant_ids = await tenants_of_user(session_factory, user_id)
        if len(tenant_ids) != 1:
            raise TenantMembershipError(
                f"user {user_id} has {len(tenant_ids)} tenant memberships; "
                "expected exactly 1"
            )
        return tenant_ids[0]
