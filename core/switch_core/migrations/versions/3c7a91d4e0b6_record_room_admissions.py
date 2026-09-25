"""Record the room deliveries an agent's controller has been admitted to make

Revision ID: 3c7a91d4e0b6
Revises: 7f1c0b93ae52
Create Date: 2026-09-22

Which session of an agent is in a room is the server's answer, and until now a
controller worked it out from the session files on its own disk. Those files
outlive the sessions that wrote them, so a stopped session goes on claiming a
room it left and the controller routes to nobody. This is where the answer is
recorded instead: the verified event, so the promise survives the replay buffer
being trimmed, the grant to start one session for a room nothing holds, so two
deliveries seconds apart cannot each start one, and the mark a controller
leaves when it gives a delivery up, so a session cannot go on to make one that
is no longer owed.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "3c7a91d4e0b6"
down_revision = "7f1c0b93ae52"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sdk_room_admissions",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_sdk_room_admissions_tenant"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("delivery", postgresql.JSONB(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("grant_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("granted_session_id", sa.Text(), nullable=True),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("discarded_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("tenant_id", "agent_id", "room_id", "message_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_sdk_room_admissions_agent",
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_sdk_room_admissions_room",
        "sdk_room_admissions",
        ["tenant_id", "agent_id", "room_id"],
    )
    op.execute("ALTER TABLE sdk_room_admissions ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON sdk_room_admissions FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("sdk_room_admissions")
