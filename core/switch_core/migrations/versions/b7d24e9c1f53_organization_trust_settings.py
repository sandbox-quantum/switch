"""organization_trust_settings: a Switch Trust policy per organization

Until now one Switch Trust policy, the `trust_settings` row the platform
operator set, checked every message on the server. Each organization now
connects its own, and a message is checked against its workspace's
organization's policy, or not at all when it has none.

So that nothing checked before the upgrade goes unchecked after it, the
server's policy, when one was set (a policy id and a key), is copied into
every organization there is. Its key is copied as it is encrypted: the keyring
binds a value to no row or organization. An organization made afterwards
starts with none.

`trust_settings` itself is left as it is. A release from before this one,
running beside it during the upgrade, still checks against it; a later release
drops it.

The `organization_isolation` policy is written out below rather than
inherited, for the reason `265ed188ad6f` gives, as a verbatim copy of
`switch_core/db/rls_ddl.py` as it stood when this migration was written. The
copy is made as the migration's role, which the policy does not bind, as
`238c68b7306e` seeded `organizations`.

Expand only: a release from before this revision never reads the new table,
and nothing it reads is changed.

Revision ID: b7d24e9c1f53
Revises: 861ff8767cf4
Create Date: 2026-11-12 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d24e9c1f53"
down_revision: str | None = "861ff8767cf4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "organization_trust_settings"
POLICY_NAME = "organization_isolation"
_PREDICATE = '"organization_id" = (SELECT require_organization_id())'

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ({_PREDICATE})
    WITH CHECK ({_PREDICATE})"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'

COPY_SERVER_POLICY = f"""INSERT INTO "{TABLE}"
    (organization_id, endpoint, policy_id, api_key_encrypted)
SELECT organizations.id, trust_settings.endpoint, trust_settings.policy_id,
    trust_settings.api_key_encrypted
FROM organizations CROSS JOIN trust_settings
WHERE trust_settings.id = 'global'
    AND trust_settings.policy_id IS NOT NULL
    AND trust_settings.policy_id <> ''
    AND trust_settings.api_key_encrypted IS NOT NULL"""


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("policy_id", sa.Text(), nullable=False),
        sa.Column("policy_name", sa.Text(), nullable=True),
        sa.Column("api_key_encrypted", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("organization_id"),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_organization_trust_settings_organization",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name="fk_organization_trust_settings_updated_by",
            ondelete="SET NULL",
        ),
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)
    op.execute(COPY_SERVER_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
