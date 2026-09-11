"""add stored_templates table and seed Switch expert

Revision ID: 03463c958b95
Revises: b47e0c39a1f5
Create Date: 2026-09-11 00:00:00.000000

"""

import json
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "03463c958b95"
down_revision: str | None = "b47e0c39a1f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SWITCH_EXPERT_ID = "00000000-0000-0000-0000-000000000001"


def _load_persona() -> str:
    persona_path = Path(__file__).resolve().parents[4] / "switch-expert" / "AGENT.md"
    return persona_path.read_text()


def upgrade() -> None:
    op.create_table(
        "stored_templates",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("name", sa.Text(), unique=True, nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("definition", sa.Text(), nullable=False),
        sa.Column("creator", sa.Text(), nullable=False),
        sa.Column("repo_url", sa.Text(), nullable=True),
        sa.Column("sources", JSONB(), nullable=True),
        sa.Column(
            "is_bundled",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
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
    )

    switch_expert_sources = [
        {"url": "https://docs.flintai.dev", "label": "Switch documentation"},
        {
            "url": "https://docs.flintai.dev/getting-started",
            "label": "Getting started guide",
        },
        {
            "url": "https://docs.flintai.dev/working-in-switch",
            "label": "Working in Switch",
        },
    ]

    op.execute(
        sa.text(
            """
            INSERT INTO stored_templates
                (id, name, description, kind, definition, creator, repo_url, sources, is_bundled)
            VALUES
                (:id, :name, :description, :kind, :definition, :creator, :repo_url, :sources, true)
            """
        ).bindparams(
            id=SWITCH_EXPERT_ID,
            name="Switch Expert",
            description="Answers questions about Switch and helps design and build things with it. Grounded in a local clone of the Switch repository, which it re-reads rather than answering from memory.",
            kind="agent",
            definition=_load_persona(),
            creator="Switch",
            repo_url="https://github.com/sandbox-quantum/switch",
            sources=json.dumps(switch_expert_sources),
        )
    )


def downgrade() -> None:
    op.drop_table("stored_templates")
