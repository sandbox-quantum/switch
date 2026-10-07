"""what one platform has to remember about an install

`messaging_installs` recorded the same few things for every platform: the
workspace, the credential, the scopes. The distributed Teams app needs to keep
something only Teams has — the id Microsoft gave our app in the customer
organisation's own catalogue, which differs per organisation and is needed to
add the app to a team or push it a new version — and there was nowhere to put
it that a workspace admin could not edit.

So the table gains `platform_data`, a JSONB object each platform reads and
writes for itself. Not a secret store: secrets keep their encrypted column.
Empty for every existing row, and for a platform with nothing to keep.

Revision ID: e4b7d2a91c06
Revises: 2f6919dcdead
Create Date: 2026-10-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e4b7d2a91c06"
down_revision: str | None = "2f6919dcdead"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messaging_installs",
        sa.Column(
            "platform_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("messaging_installs", "platform_data")
