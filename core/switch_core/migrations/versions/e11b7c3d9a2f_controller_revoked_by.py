"""controller revoked by: why a hosted block revoked it

`agent_controllers.revoked_by`, nullable, `pause` or `turn_off`: set only when
an operator's pause or a workspace admin's turn-off revoked the controller.
Once that block is lifted, a message to the controller's
agents may wake its hosted box, which enrols a new controller with a fresh
one-time code; the revoked one stays revoked. Every other revoke leaves it
NULL, and clears it on a row a pause already revoked. Existing rows stay NULL
(no backfill), so a controller revoked before this column existed is never
woken this way.

Additive: a new nullable column and a check, so an older Core, which never
names it, reads and writes on as before. The downgrade drops the column: a box
revoked by a pause then just stays down after the resume, as it did before,
which is the safe side.

Revision ID: e11b7c3d9a2f
Revises: a90e3df4fe3f
Create Date: 2026-11-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e11b7c3d9a2f"
down_revision: str | Sequence[str] | None = "a90e3df4fe3f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_CHECK = "revoked_by IS NULL OR revoked_by IN ('pause', 'turn_off')"


def upgrade() -> None:
    op.add_column(
        "agent_controllers", sa.Column("revoked_by", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_agent_controllers_revoked_by", "agent_controllers", _CHECK
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_agent_controllers_revoked_by", "agent_controllers", type_="check"
    )
    op.drop_column("agent_controllers", "revoked_by")
