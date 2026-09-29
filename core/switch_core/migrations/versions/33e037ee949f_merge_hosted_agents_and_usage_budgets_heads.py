"""Merge the hosted-agent migration head with main's head.

Runs after `b9e4d2a71c05` dropped the old server-side session tables, in the
same transaction, so it refuses that drop unless the gate
`hosted-cutover-upgrade` checks before it upgrades still holds; this is what
stops an ungated `alembic upgrade head`, the one Core runs at boot among them.
`migrations/env.py` has already checked the whole gate before the drop; what
it reads from the old tables cannot be checked again here. The queries are a
frozen copy of `switch_core/db/hosted_cutover_gate.py` as of this revision. A
database with no hosted launches passes.
"""

import sqlalchemy as sa
from alembic import op

revision = "33e037ee949f"
down_revision = ("a3c9e5f71d28", "c4e9a1f7b203")
branch_labels = None
depends_on = None

_RUNNING_LAUNCHES = """
    SELECT id FROM hosted_launches
    WHERE state NOT IN ('deleting', 'deleted')
      AND NOT (state = 'stopped' AND desired_state = 'stopped' AND sleeping = false)
    ORDER BY id
"""
_HOSTED_AGENTS = """
    SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
    FROM hosted_launches
    WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
    ORDER BY tenant_id, agent_id, created_at DESC
"""
_RETAINED = """
    JOIN hosted_launches l ON l.tenant_id = {alias}.tenant_id AND l.id = {alias}.launch_id
      AND l.state NOT IN ('deleting', 'deleted')
"""
_IMPORT_BLOBS = f"""
    SELECT i.tenant_id, i.launch_id, a->>'mxc' AS uri
    FROM hosted_cutover_items i
    {_RETAINED.format(alias="i")}
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) a
    WHERE i.disposition = 'import'
"""
_VOLUMES: list[tuple[str, str]] = [
    (
        f"""
        SELECT h.launch_id FROM ({_HOSTED_AGENTS}) h
        WHERE NOT EXISTS (SELECT 1 FROM hosted_cutover_volumes v
            WHERE v.tenant_id = h.tenant_id AND v.launch_id = h.launch_id)
        ORDER BY 1
        """,
        "launch {} has no cutover volume; it was created after `prepare`, so "
        "downgrade to 95fc38e451b6 and run `prepare` again",
    ),
    (
        f"""
        SELECT v.launch_id FROM hosted_cutover_volumes v {_RETAINED.format(alias="v")}
        WHERE v.preflight_state = 'pending' ORDER BY 1
        """,
        "the volume of launch {} has no recorded preflight check; run "
        "`--preflight-check` on it and `record` the result",
    ),
    (
        f"""
        SELECT v.launch_id || ': ' || COALESCE(v.blocked_reason, '')
        FROM hosted_cutover_volumes v {_RETAINED.format(alias="v")}
        WHERE v.preflight_state = 'blocked' ORDER BY 1
        """,
        "the preflight check blocked on the volume of launch {}; repair the file "
        "it names, check the volume again and `record` the result",
    ),
    (
        f"""
        SELECT DISTINCT i.launch_id FROM hosted_cutover_items i {_RETAINED.format(alias="i")}
        WHERE i.disposition IS NULL ORDER BY 1
        """,
        "launch {} has cutover items no manifest decided; `record` its volume",
    ),
    (
        f"""
        SELECT i.launch_id || ' ' || i.room_id || ' ' || i.message_id
        FROM hosted_cutover_items i {_RETAINED.format(alias="i")}
        WHERE i.disposition = 'import' AND i.payload IS NULL ORDER BY 1
        """,
        "the import {} has no event to queue",
    ),
    (
        f"""
        SELECT b.launch_id || ' ' || b.uri FROM ({_IMPORT_BLOBS}) b
        WHERE NOT EXISTS (SELECT 1 FROM media_blobs m
            WHERE m.tenant_id = b.tenant_id AND m.uri = b.uri)
        ORDER BY 1
        """,
        "the attachment of an import for launch {} is gone",
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    problems = [
        f"launch {launch_id} is not stopped"
        for launch_id in bind.scalars(sa.text(_RUNNING_LAUNCHES))
    ]
    for query, message in _VOLUMES:
        problems += [message.format(row) for row in bind.scalars(sa.text(query))]
    if problems:
        raise RuntimeError(
            "Refusing to drop the old session tables before the hosted cutover is "
            "complete: "
            + "; ".join(problems)
            + ". Run `just hosted-cutover-upgrade status` and follow the cutover "
            "steps in docs/hosted-activity-contracts.md."
        )


def downgrade() -> None:
    pass
