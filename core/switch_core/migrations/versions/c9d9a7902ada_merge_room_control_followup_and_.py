"""merge room control followup and invitations heads

Two heads met when main was merged into the messaging-platforms stack:
`5daaea6b674d` (invitations) came from main, `d94a7f1b5230` (the
`sdk_session_commands.room_control_followup` column) from the stack. They
touch nothing in common, so the merge carries no operations of its own — it
exists only so `alembic upgrade head` resolves to one revision again, which
is what switch-core runs at startup.

Revision ID: c9d9a7902ada
Revises: d94a7f1b5230, 5daaea6b674d
Create Date: 2026-09-15 15:36:28.858477

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "c9d9a7902ada"
down_revision: str | Sequence[str] | None = ("d94a7f1b5230", "5daaea6b674d")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
