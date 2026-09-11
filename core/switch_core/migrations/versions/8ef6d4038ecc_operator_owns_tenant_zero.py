"""operator/workspace-admin role split: the seeded administrator becomes an owner of tenant zero

Revision ID: 8ef6d4038ecc
Revises: a3f61c02d5be
Create Date: 2026-09-11 00:00:00.000000

Phase 2 of multi-tenancy (`docs/old/multi-tenancy-phase2-tenants.md`, §2)
starts reading `tenant_members.role` instead of leaving it inert:
`authz.Principal.is_admin` now grants tenant-scoped administrative power to a
caller whose membership role in the bound tenant is `owner`/`admin`, not only
to the deployment operator bit (`users.role == "admin"`, still global, still
an unconditional bypass, still never self-service).

That bypass is exactly why this migration is not a lockout fix. An operator
administers every tenant regardless of what `tenant_members` says about them,
before this change and after it — nothing here can strand an operator out of
their own deployment, because nothing here is what lets them in. What this
migration fixes is a *label*: a deployment whose operator's own membership
row still says `member` would show that operator as a guest of the tenant
they administer, in any future member listing or ownership check that reads
`tenant_members` instead of going through `authz`. Correcting it now, once,
means that surface can be built later without also auditing every deployment
that upgraded before it existed.

Two ways an operator's row can already disagree with `owner`:

- The Phase 1 schema migration (`8b276792ee30`) backfilled `owner` for every
  user whose `role` was `admin` at the time it ran, and `member` for everyone
  else. It cannot see a promotion that happened after.
- `UserStore.ensure_membership` writes a membership exactly once, at account
  creation, deriving its role from `users.role` at that moment. Promoting an
  account to `admin` afterwards — a direct database edit, since there is no
  gateway endpoint for it (`multi-tenancy-phase2-tenants.md` §8) — never
  revisits the row that promotion left behind.

So every user with `users.role = 'admin'` gets an `owner` row in tenant zero:
updated in place if their row there is `member`, inserted if they have no row
there at all. The `INSERT` covers a state the two paths above should not be
able to produce today (`ensure_membership` runs inside `UserStore.create`,
which never leaves an account without one) but which nothing enforces at the
database level — cheaper to close here than to assume.

Nothing else moves. A non-operator's row is left exactly as it is, matching
this phase's stated invariant that anyone with a single membership and no
operator bit sees no behavioural change from this release. Only tenant zero
is touched: it is the only tenant that can exist in a deployment old enough
to need this migration at all.

Idempotent: re-running it updates nothing the first run did not already fix,
and inserts nothing that already exists.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "8ef6d4038ecc"
down_revision: str | None = "a3f61c02d5be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE tenant_members
        SET role = 'owner'
        WHERE tenant_id = '{TENANT_ZERO_ID}'
          AND role NOT IN ('owner', 'admin')
          AND user_id IN (SELECT id FROM users WHERE role = 'admin')
        """
    )
    op.execute(
        f"""
        INSERT INTO tenant_members (tenant_id, user_id, role)
        SELECT '{TENANT_ZERO_ID}', u.id, 'owner'
        FROM users u
        WHERE u.role = 'admin'
          AND NOT EXISTS (
              SELECT 1 FROM tenant_members tm
              WHERE tm.tenant_id = '{TENANT_ZERO_ID}' AND tm.user_id = u.id
          )
        """
    )


def downgrade() -> None:
    # Not reversible: the rows this corrected were indistinguishable from an
    # ordinary `owner` row the moment it ran, and rows it inserted have no
    # prior state to restore — there was no row there before.
    pass
