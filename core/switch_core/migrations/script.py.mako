"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

# revision identifiers, used by Alembic.
revision: str = ${repr(up_revision)}
down_revision: Union[str, None] = ${repr(down_revision)}
branch_labels: Union[str, Sequence[str], None] = ${repr(branch_labels)}
depends_on: Union[str, Sequence[str], None] = ${repr(depends_on)}
# True only when a switch-core release from before this revision can go on
# serving on the schema it leaves: it adds tables, nullable or defaulted
# columns, or indexes, and drops, renames or tightens nothing an older release
# reads or writes. During a rolling deploy both releases serve at once, and an
# older one restarted after this ran accepts it only if this is True
# (`db/schema_version.py`). A contracting change ships as its own revision, a
# release after the code stopped using what it removes.
expand_only: bool = False


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
