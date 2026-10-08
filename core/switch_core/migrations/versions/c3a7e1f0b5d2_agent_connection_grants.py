"""grant connections to agents instead of one repository

An agent definition no longer names one GitHub repository
(`repository: {installation_id, repository_id}`). It grants connections:
`connections: [{slug: "github", installations: [{installation_id,
repositories: [ids] | "all"}]}]`. A definition with a repository is given a
GitHub grant of that one repository. Its `directory` is kept, so the agent
keeps the worktree it already has on disk. A definition with
`repository: null` loses the key. Each changed definition bumps its revision,
and its controller's assignment revision, so the controller fetches it again.

Downgrade turns a grant of exactly one repository back into `repository` and
refuses any other grant, which the old shape cannot hold.

Revision ID: c3a7e1f0b5d2
Revises: 0019a00db8f6
Create Date: 2026-10-07 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "c3a7e1f0b5d2"
down_revision: str | Sequence[str] | None = "0019a00db8f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _bump_controllers(changed: str) -> None:
    op.execute(
        f"""
        UPDATE agent_controllers AS c
        SET assignment_revision = c.assignment_revision + 1
        FROM (SELECT DISTINCT tenant_id, controller_id FROM {changed}
              WHERE controller_id IS NOT NULL) AS d
        WHERE c.tenant_id = d.tenant_id AND c.id = d.controller_id
        """
    )


def upgrade() -> None:
    op.execute(
        """
        CREATE TEMPORARY TABLE changed_definitions AS
        WITH changed AS (
            UPDATE agent_definitions
            SET definition = (definition - 'repository') || jsonb_build_object(
                    'connections',
                    CASE WHEN jsonb_typeof(definition->'repository') = 'object'
                    THEN jsonb_build_array(jsonb_build_object(
                        'slug', 'github',
                        'installations', jsonb_build_array(jsonb_build_object(
                            'installation_id',
                            definition->'repository'->'installation_id',
                            'repositories',
                            jsonb_build_array(
                                definition->'repository'->'repository_id'
                            )
                        ))
                    ))
                    ELSE '[]'::jsonb END
                ),
                revision = revision + 1,
                updated_at = now()
            WHERE definition ? 'repository'
            RETURNING tenant_id, controller_id
        )
        SELECT * FROM changed
        """
    )
    _bump_controllers("changed_definitions")
    op.execute("DROP TABLE changed_definitions")


def downgrade() -> None:
    bind = op.get_bind()
    unconvertible = bind.execute(
        text(
            """
            SELECT agent_id FROM agent_definitions
            WHERE jsonb_array_length(COALESCE(definition->'connections', '[]'))
                    > 0
              AND NOT (
                jsonb_array_length(definition->'connections') = 1
                AND definition->'connections'->0->>'slug' = 'github'
                AND jsonb_array_length(
                    definition->'connections'->0->'installations') = 1
                AND jsonb_typeof(definition->'connections'->0->'installations'
                    ->0->'repositories') = 'array'
                AND jsonb_array_length(definition->'connections'->0
                    ->'installations'->0->'repositories') = 1
              )
            """
        )
    ).scalars()
    refused = sorted(unconvertible)
    if refused:
        raise RuntimeError(
            "These agents are granted more than one GitHub repository, which a "
            f"definition before connection grants cannot hold: {refused}"
        )
    op.execute(
        """
        CREATE TEMPORARY TABLE changed_definitions AS
        WITH changed AS (
            UPDATE agent_definitions
            SET definition = (definition - 'connections') || CASE
                    WHEN jsonb_array_length(definition->'connections') = 1
                    THEN jsonb_build_object('repository', jsonb_build_object(
                        'installation_id',
                        definition->'connections'->0->'installations'->0
                            ->'installation_id',
                        'repository_id',
                        definition->'connections'->0->'installations'->0
                            ->'repositories'->0
                    ))
                    ELSE '{}'::jsonb END,
                revision = revision + 1,
                updated_at = now()
            WHERE definition ? 'connections'
            RETURNING tenant_id, controller_id
        )
        SELECT * FROM changed
        """
    )
    _bump_controllers("changed_definitions")
    op.execute("DROP TABLE changed_definitions")
