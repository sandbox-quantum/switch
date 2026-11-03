"""trust settings: whether agent instructions go to Switch Trust's inventory

`trust_settings.share_agent_instructions` says whether the agent inventory
this server sends Switch Trust carries each managed agent's instructions.
Off by default: an agent's instructions are its operator's to share, and a
deployment that configured Switch Trust before the inventory existed agreed
to message checks, not to sending its prompts.

Expand only: a release from before this revision never reads the column and
never sends an inventory.

Revision ID: 3b8e5d1f7a92
Revises: 22e1d92cfd4c
Create Date: 2026-11-03 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3b8e5d1f7a92"
down_revision: str | None = "22e1d92cfd4c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "trust_settings",
        sa.Column(
            "share_agent_instructions",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("trust_settings", "share_agent_instructions")
