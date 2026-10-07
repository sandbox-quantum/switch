"""cloud machines on the shared agent controller, and sealed provider logins

`hosted_machines.runtime` says what a cloud machine runs: the hosted worker
(`worker`, every existing machine) or the shared agent controller
(`controller`), as the ec2 controller `controller_id`. That controller's
credential is kept keyring-encrypted per machine revision, the way the
worker's machine capability is, so a retried prepare returns the same one.

`sealed_provider_credentials` holds a provider login sealed with KMS for one
ec2 controller. A login held only that way has no keyring copy, so
`provider_connections.encrypted_credential` becomes nullable.

Downgrade refuses while any connection is held only sealed: there is nothing
to put back in the column, and dropping the row would silently disconnect it.

Revision ID: 9e3b7c51a2d4
Revises: c4013951b559
Create Date: 2026-10-05 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "9e3b7c51a2d4"
down_revision: str | Sequence[str] | None = "c4013951b559"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_machines",
        sa.Column("runtime", sa.Text(), nullable=False, server_default="worker"),
    )
    op.add_column("hosted_machines", sa.Column("controller_id", sa.Text()))
    op.add_column(
        "hosted_machines", sa.Column("controller_credential_encrypted", sa.Text())
    )
    op.add_column(
        "hosted_machines", sa.Column("controller_credential_revision", sa.Integer())
    )
    op.create_check_constraint(
        "ck_hosted_machine_runtime",
        "hosted_machines",
        "runtime IN ('worker', 'controller')",
    )
    op.create_foreign_key(
        "fk_hosted_machines_controller",
        "hosted_machines",
        "agent_controllers",
        ["tenant_id", "controller_id"],
        ["tenant_id", "id"],
    )

    op.alter_column("provider_connections", "encrypted_credential", nullable=True)

    op.create_table(
        "sealed_provider_credentials",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_sealed_provider_credentials_tenant"),
            nullable=False,
        ),
        sa.Column(
            "owner_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("controller_id", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("envelope", JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "controller_id", "provider"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_sealed_provider_credentials_controller",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "provider IN ('claude', 'codex', 'opencode', 'cursor', 'antigravity')",
            name="ck_sealed_provider_credentials_provider",
        ),
        sa.CheckConstraint(
            "status IN ('connected', 'revoked')",
            name="ck_sealed_provider_credentials_status",
        ),
        sa.CheckConstraint(
            "revision >= 1", name="ck_sealed_provider_credentials_revision"
        ),
    )
    op.create_index(
        "ix_sealed_provider_credentials_owner",
        "sealed_provider_credentials",
        ["tenant_id", "owner_id", "provider"],
    )
    op.execute("ALTER TABLE sealed_provider_credentials ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON sealed_provider_credentials FOR ALL "
        "USING (tenant_id = (SELECT require_tenant_id())) "
        "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    sealed_only = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT count(*) FROM provider_connections "
                "WHERE encrypted_credential IS NULL"
            )
        )
        .scalar_one()
    )
    if sealed_only:
        raise RuntimeError(
            f"{sealed_only} provider connection(s) are held only sealed for an "
            "ec2 controller and have no keyring copy to keep; migrate their "
            "owners back to the worker runtime and reconnect them first"
        )
    op.drop_index(
        "ix_sealed_provider_credentials_owner",
        table_name="sealed_provider_credentials",
    )
    op.drop_table("sealed_provider_credentials")
    op.alter_column("provider_connections", "encrypted_credential", nullable=False)
    op.drop_constraint(
        "fk_hosted_machines_controller", "hosted_machines", type_="foreignkey"
    )
    op.drop_constraint("ck_hosted_machine_runtime", "hosted_machines", type_="check")
    op.drop_column("hosted_machines", "controller_credential_revision")
    op.drop_column("hosted_machines", "controller_credential_encrypted")
    op.drop_column("hosted_machines", "controller_id")
    op.drop_column("hosted_machines", "runtime")
