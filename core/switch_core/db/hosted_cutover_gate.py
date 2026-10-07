"""What the drop of the old server-side session tables waits for on a hosted deployment.

Plain SQL on a synchronous connection, so `hosted-cutover-upgrade`,
`migrations/env.py` and the merge revision `33e037ee949f` evaluate the same
conditions. `env.py` checks them on the migration connection before the first
revision of any upgrade plan that includes `b9e4d2a71c05`, while the old
tables can still be read; the merge revision checks again after the drop, and
there whatever needs the old tables is gone and skipped.
"""

from __future__ import annotations

from sqlalchemy import Connection, text

DROP_REVISION = "b9e4d2a71c05"

RUNNING_LAUNCHES = """
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

_VOLUMES: list[tuple[str, str]] = [
    (
        """
        SELECT h.launch_id FROM (
            SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
            FROM hosted_launches
            WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
            ORDER BY tenant_id, agent_id, created_at DESC
        ) h
        WHERE NOT EXISTS (SELECT 1 FROM hosted_cutover_volumes v
            WHERE v.tenant_id = h.tenant_id AND v.launch_id = h.launch_id)
        ORDER BY 1
        """,
        "launch {} has no cutover volume; it was created after `prepare`, so "
        "downgrade to 95fc38e451b6 and run `prepare` again",
    ),
    (
        """
        SELECT v.launch_id FROM hosted_cutover_volumes v
        JOIN hosted_launches l ON l.tenant_id = v.tenant_id AND l.id = v.launch_id
          AND l.state NOT IN ('deleting', 'deleted')
        WHERE v.preflight_state = 'pending' ORDER BY 1
        """,
        "the volume of launch {} has no recorded preflight check; run "
        "`--preflight-check` on it and `record` the result",
    ),
    (
        """
        SELECT v.launch_id || ': ' || COALESCE(v.blocked_reason, '')
        FROM hosted_cutover_volumes v
        JOIN hosted_launches l ON l.tenant_id = v.tenant_id AND l.id = v.launch_id
          AND l.state NOT IN ('deleting', 'deleted')
        WHERE v.preflight_state = 'blocked' ORDER BY 1
        """,
        "the preflight check blocked on the volume of launch {}; repair the file "
        "it names, check the volume again and `record` the result",
    ),
    (
        """
        SELECT DISTINCT i.launch_id FROM hosted_cutover_items i
        JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
          AND l.state NOT IN ('deleting', 'deleted')
        WHERE i.disposition IS NULL ORDER BY 1
        """,
        "launch {} has cutover items no manifest decided; `record` its volume",
    ),
    (
        """
        SELECT i.launch_id || ' ' || i.room_id || ' ' || i.message_id
        FROM hosted_cutover_items i
        JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
          AND l.state NOT IN ('deleting', 'deleted')
        WHERE i.disposition = 'import' AND i.payload IS NULL ORDER BY 1
        """,
        "the import {} has no event to queue",
    ),
    (
        """
        SELECT b.launch_id || ' ' || b.uri FROM (
            SELECT i.tenant_id, i.launch_id, a->>'mxc' AS uri
            FROM hosted_cutover_items i
            JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
              AND l.state NOT IN ('deleting', 'deleted')
            CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) a
            WHERE i.disposition = 'import'
        ) b
        WHERE NOT EXISTS (SELECT 1 FROM media_blobs m
            WHERE m.tenant_id = b.tenant_id AND m.uri = b.uri)
        ORDER BY 1
        """,
        "the attachment of an import for launch {} is gone",
    ),
]

_OLD_TABLES: list[tuple[str, str]] = [
    (
        """
        SELECT b.launch_id || ' ' || b.uri FROM (
            SELECT i.tenant_id, i.launch_id, a->>'mxc' AS uri
            FROM hosted_cutover_items i
            JOIN hosted_launches l ON l.tenant_id = i.tenant_id AND l.id = i.launch_id
              AND l.state NOT IN ('deleting', 'deleted')
            CROSS JOIN LATERAL jsonb_array_elements(
                COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) a
            WHERE i.disposition = 'import'
        ) b
        WHERE EXISTS (SELECT 1 FROM media_blobs m
            WHERE m.tenant_id = b.tenant_id AND m.uri = b.uri
              AND m.sdk_session_id IS NOT NULL)
        ORDER BY 1
        """,
        "the attachment of an import for launch {} would be dropped with its "
        "session; `record` the volume again to keep it",
    ),
    (
        """
        SELECT latest.command_id FROM (
            SELECT DISTINCT ON (c.tenant_id, s.agent_id, c.command->'origin'->>'roomId',
                                c.command->'origin'->>'messageId')
                c.tenant_id, s.agent_id, c.command_id, c.status->>'status' AS status,
                c.command->'origin'->>'roomId' AS room_id,
                c.command->'origin'->>'messageId' AS message_id
            FROM sdk_session_commands c
            JOIN sdk_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
            JOIN (
                SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
                FROM hosted_launches
                WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
                ORDER BY tenant_id, agent_id, created_at DESC
            ) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
            WHERE c.command->'body'->>'type' = 'message.send'
              AND c.command->'origin'->>'roomId' IS NOT NULL
              AND c.command->'origin'->>'messageId' IS NOT NULL
            ORDER BY c.tenant_id, s.agent_id, c.command->'origin'->>'roomId',
                     c.command->'origin'->>'messageId', c.accepted_sequence DESC, c.command_id DESC
        ) latest
        WHERE NOT EXISTS (SELECT 1 FROM hosted_cutover_items i
            WHERE i.tenant_id = latest.tenant_id AND i.agent_id = latest.agent_id
              AND i.kind = 'room_message' AND i.room_id = latest.room_id
              AND i.message_id = latest.message_id
              AND i.evidence->'core'->>'command_id' = latest.command_id
              AND i.evidence->'core'->>'status' IS NOT DISTINCT FROM latest.status)
        UNION ALL
        SELECT c.command_id FROM sdk_session_commands c
        JOIN sdk_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
        JOIN (
            SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
            FROM hosted_launches
            WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
            ORDER BY tenant_id, agent_id, created_at DESC
        ) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE c.command->'origin'->>'surface' = 'console'
          AND c.command->'origin'->>'roomId' IS NULL
          AND c.status->>'status' = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM hosted_cutover_items i
            WHERE i.tenant_id = c.tenant_id AND i.agent_id = s.agent_id
              AND i.kind = 'console_command'
              AND i.evidence->'core'->>'command_id' = c.command_id)
        UNION ALL
        SELECT p.request_id FROM session_request_posts p
        JOIN sdk_sessions s ON s.tenant_id = p.tenant_id AND s.id = p.session_id
        JOIN (
            SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
            FROM hosted_launches
            WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
            ORDER BY tenant_id, agent_id, created_at DESC
        ) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE p.removed_at IS NULL AND p.room_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hosted_cutover_items i
            WHERE i.tenant_id = p.tenant_id AND i.agent_id = s.agent_id
              AND i.kind = 'request_open'
              AND i.evidence->'core'->>'request_id' = p.request_id)
        ORDER BY 1
        """,
        "{} changed in the old session tables after `prepare` captured them, so "
        "the old Core ran again; downgrade to 95fc38e451b6 and run `prepare` again",
    ),
]


def _present(connection: Connection, table: str) -> bool:
    return bool(
        connection.scalar(
            text("SELECT to_regclass(:table) IS NOT NULL"), {"table": table}
        )
    )


def cutover_gate_problems(connection: Connection) -> list[str]:
    """Everything that still stops the drop, each naming its launch or item."""
    if not _present(connection, "hosted_launches"):
        return []
    problems = [
        f"launch {launch_id} is not stopped"
        for launch_id in connection.scalars(text(RUNNING_LAUNCHES))
    ]
    if not _present(connection, "hosted_cutover_volumes"):
        return problems + [
            f"launch {row.launch_id} has hosted state the cutover has not captured"
            for row in connection.execute(text(_HOSTED_AGENTS))
        ]
    gate = _VOLUMES + (_OLD_TABLES if _present(connection, "sdk_sessions") else [])
    for query, message in gate:
        problems += [message.format(row) for row in connection.scalars(text(query))]
    return problems


def refuse_incomplete_cutover(connection: Connection) -> None:
    """Raise unless the drop of the old session tables may go ahead."""
    problems = cutover_gate_problems(connection)
    if problems:
        raise RuntimeError(
            "Refusing to drop the old session tables before the hosted cutover is "
            "complete: "
            + "; ".join(problems)
            + ". This database predates the controller runtime: upgrade it first "
            "with a Switch release that still has the cutover tool."
        )
