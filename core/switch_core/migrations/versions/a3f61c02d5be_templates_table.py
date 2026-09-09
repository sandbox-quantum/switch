"""templates are held on the server, not passed around as files

Revision ID: a3f61c02d5be
Revises: 04f27f37e474

A template has until now been a YAML file someone mailed you. This table is
where a Switch server keeps one, so a template can be uploaded once and found
by everyone on the server afterwards (CHOO-2677).

Two choices here are deliberate and worth stating, because they are what let
the format keep moving without this table moving with it.

``content`` is ``Text`` and holds the document exactly as it was uploaded. The
registry never parses, validates or normalises it. That is what makes the
round-trip byte-identical, and it means a document written for a newer format
than this server understands is still stored and served back intact rather
than rejected at the door.

``kind`` is free text rather than an enum or a check constraint. Room, group
and agent templates are all coming, and they should differ by a string, not by
a migration. An enum here would buy nothing and cost a schema change per kind.

Uniqueness is ``(owner_id, name)``, not ``name``: two people may each keep a
template called "deploy-room", but neither may keep two of their own by that
name. Scoping it to the owner rather than the server is also what makes this
survive the tenant work — an owner belongs to a tenant, so the constraint
narrows correctly instead of needing to be rebuilt.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3f61c02d5be"
down_revision: str | Sequence[str] | None = "04f27f37e474"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "templates",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("owner_id", "name", name="uq_templates_owner_name"),
    )


def downgrade() -> None:
    op.drop_table("templates")
