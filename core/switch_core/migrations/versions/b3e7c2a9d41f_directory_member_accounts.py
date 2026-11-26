"""accounts for directory members who never signed in

The WorkOS directory mirror makes an account for an organization member who
has never signed in to Switch, so that its admins see them and can add them
to a workspace.

- `users.first_signed_in_at`: when the person first signed in, if ever.
  Every existing account is taken as signed in when it was made.
- `users.created_by_directory`: the mirror made the account. Only such an
  account, until its first sign-in, does the mirror rename or delete; an
  account a release before this one makes reads false, so a rolling deploy
  cannot leave one the mirror would take as its own.
- `organizations_of_user`, a lookup in the exemption from row-level security:
  which organizations a person is in, read before the mirror deletes an
  account it made, across every organization rather than only those that
  follow WorkOS.

The DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py` as it
stood when this migration was written, copied rather than imported so a later
edit cannot change what this revision means.

Revision ID: b3e7c2a9d41f
Revises: a25845a0e7be
Create Date: 2026-11-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3e7c2a9d41f"
down_revision: str | Sequence[str] | None = "a25845a0e7be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_ORGANIZATIONS_OF_USER = f"""CREATE OR REPLACE FUNCTION organizations_of_user(p_user_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT organization_id FROM organization_members WHERE user_id = p_user_id ORDER BY organization_id$$"""

DROP_ORGANIZATIONS_OF_USER = "DROP FUNCTION IF EXISTS organizations_of_user(text)"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("first_signed_in_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE users SET first_signed_in_at = created_at")
    op.add_column(
        "users",
        sa.Column(
            "created_by_directory",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.execute(CREATE_ORGANIZATIONS_OF_USER)


def downgrade() -> None:
    op.execute(DROP_ORGANIZATIONS_OF_USER)
    op.drop_column("users", "created_by_directory")
    op.drop_column("users", "first_signed_in_at")
