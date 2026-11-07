"""session version: end a person's sessions everywhere

``users.session_version`` is carried in every session cookie and compared on
every request, so incrementing it signs the person out on every device. The
trigger increments it when the password hash or a server-admin role changes,
however the change is made.

Expand only: a process from before this revision neither writes nor reads the
column, and the trigger touches only rows it would have updated anyway.

Revision ID: c7b2e9f4a1d6
Revises: e5c1b7a93d28
Create Date: 2026-11-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7b2e9f4a1d6"
down_revision: str | None = "e5c1b7a93d28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

# Copies of the DDL in `db/session_version_ddl.py`, written out here so this
# migration keeps creating the same objects if that module changes.
CREATE_SESSION_VERSION_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_bump_session_version() RETURNS trigger AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
        OR (OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin') THEN
        NEW.session_version := OLD.session_version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

CREATE_SESSION_VERSION_TRIGGER = """
CREATE TRIGGER users_bump_session_version
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION switch_bump_session_version()
"""


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "session_version", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
    )
    op.execute(CREATE_SESSION_VERSION_FUNCTION)
    op.execute(CREATE_SESSION_VERSION_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS users_bump_session_version ON users")
    op.execute("DROP FUNCTION IF EXISTS switch_bump_session_version()")
    op.drop_column("users", "session_version")
