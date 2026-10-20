"""remove the hosted worker: cloud machines only run the agents controller

Drops what only the hosted worker used: cloud launches and their operations,
wake mailbox, cutover records and GitHub tokens, provider verifications, the
agent providers' credentials held for workers (GitHub connections stay), and
the worker columns of `hosted_machines`.

Refuses to run while a cloud agent of the hosted worker is not removed, or a
machine that runs the hosted worker is not deleted: nothing here can move them
onto the agents controller.

Revision ID: f5d2b8e6c3a1
Revises: e7a2c4b9d013
Create Date: 2026-10-09 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f5d2b8e6c3a1"
down_revision: str | None = "e7a2c4b9d013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    launches = connection.scalar(
        sa.text("SELECT count(*) FROM hosted_launches WHERE state <> 'deleted'")
    )
    machines = connection.scalar(
        sa.text(
            "SELECT count(*) FROM hosted_machines "
            "WHERE runtime = 'worker' AND state <> 'deleted'"
        )
    )
    if launches or machines:
        raise RuntimeError(
            f"remove the hosted worker: {launches} cloud agent(s) of the hosted "
            f"worker are not removed and {machines} cloud machine(s) that run it "
            "are not deleted. Remove those cloud agents in Switch Console, wait "
            "until their machines are deleted, then upgrade again."
        )

    op.drop_table("hosted_wake_mailbox")
    op.drop_table("hosted_cutover_items")
    op.drop_table("hosted_cutover_volumes")
    op.drop_table("hosted_operations")
    op.drop_table("github_issued_tokens")
    op.drop_table("hosted_launches")
    op.drop_table("provider_verifications")

    op.execute("DELETE FROM provider_connections WHERE provider <> 'github'")
    op.drop_constraint(
        "ck_provider_connections_provider", "provider_connections", type_="check"
    )
    op.drop_constraint(
        "ck_provider_connections_kind", "provider_connections", type_="check"
    )
    op.create_check_constraint(
        "ck_provider_connections_provider",
        "provider_connections",
        "provider = 'github'",
    )
    op.create_check_constraint(
        "ck_provider_connections_kind", "provider_connections", "kind = 'oauth'"
    )

    op.drop_constraint("ck_hosted_machine_runtime", "hosted_machines", type_="check")
    for column in (
        "runtime",
        "machine_capability_hash",
        "machine_capability_encrypted",
        "machine_capability_revision",
        "agents_version",
    ):
        op.drop_column("hosted_machines", column)


def downgrade() -> None:
    raise RuntimeError(
        "remove the hosted worker cannot be undone: the hosted worker's tables "
        "and the credentials held for it are gone."
    )
