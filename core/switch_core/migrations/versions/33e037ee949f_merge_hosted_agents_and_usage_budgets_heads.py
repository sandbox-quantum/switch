"""Merge the hosted-agent and usage-budget migration heads.

Runs after `b9e4d2a71c05` dropped the old server-side session tables, in the
same transaction, so it refuses that drop unless every retained volume's
preflight manifest was recorded and every import it decided still has its
attachment. `hosted-cutover-upgrade` checks the same before it upgrades and
says what to do; this is what stops an ungated `alembic upgrade head`, the
one Core runs at boot among them. A database with no cutover volumes passes.
"""

import sqlalchemy as sa
from alembic import op

revision = "33e037ee949f"
down_revision = ("a3c9e5f71d28", "e3b7c9d2a415")
branch_labels = None
depends_on = None

_UNFINISHED = """
    SELECT v.launch_id, v.preflight_state FROM hosted_cutover_volumes v
    JOIN hosted_launches l ON l.tenant_id = v.tenant_id AND l.id = v.launch_id
    WHERE l.state NOT IN ('deleting', 'deleted') AND v.preflight_state <> 'complete'
    ORDER BY v.launch_id
"""

_UNDECIDED = """
    SELECT DISTINCT i.launch_id FROM hosted_cutover_items i
    JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
    WHERE l.state NOT IN ('deleting', 'deleted') AND i.disposition IS NULL
    ORDER BY i.launch_id
"""

_MISSING_BLOBS = """
    SELECT DISTINCT a->>'mxc' FROM hosted_cutover_items i
    JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) a
    WHERE l.state NOT IN ('deleting', 'deleted') AND i.disposition = 'import'
      AND NOT EXISTS (
        SELECT 1 FROM media_blobs b WHERE b.tenant_id = i.tenant_id AND b.uri = a->>'mxc')
    ORDER BY 1
"""


def upgrade() -> None:
    bind = op.get_bind()
    unfinished = bind.execute(sa.text(_UNFINISHED)).all()
    undecided = bind.scalars(sa.text(_UNDECIDED)).all()
    missing = bind.scalars(sa.text(_MISSING_BLOBS)).all()
    problems = [
        f"volume of launch {launch_id} is {state}" for launch_id, state in unfinished
    ]
    problems += [f"launch {launch_id} has undecided items" for launch_id in undecided]
    problems += [f"import attachment {uri} is gone" for uri in missing]
    if problems:
        raise RuntimeError(
            "Refusing to drop the old session tables before every retained hosted "
            "worker volume is recorded: "
            + "; ".join(problems)
            + ". Run `just hosted-cutover-upgrade status` and follow the cutover "
            "steps in docs/hosted-activity-contracts.md."
        )


def downgrade() -> None:
    pass
