"""agent definitions: model_options becomes advanced_config

A managed agent's definition carries the provider's whole "Advanced
configuration" (`advanced_config`, checked against the server's schema for the
provider) instead of `model_options`. Stored options move across under the same
keys, and every definition gets the key, `{}` when it had none.

Downgrading keeps only what `model_options` could hold: string `effort` and
`variant` values, and only on a definition that names a model.

Revision ID: e8b4e2f62e25
Revises: c4d8e1f2a9b3
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e8b4e2f62e25"
down_revision: str | Sequence[str] | None = "c4d8e1f2a9b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE agent_definitions
        SET definition = (definition - 'model_options')
            || jsonb_build_object(
                'advanced_config',
                COALESCE(definition -> 'model_options', '{}'::jsonb)
            )
        WHERE NOT definition ? 'advanced_config'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE agent_definitions
        SET definition = (definition - 'advanced_config')
            || jsonb_build_object(
                'model_options',
                CASE
                    WHEN COALESCE(definition -> 'model', 'null'::jsonb) = 'null'::jsonb
                        THEN '{}'::jsonb
                    ELSE COALESCE(
                        (
                            SELECT jsonb_object_agg(entry.key, entry.value)
                            FROM jsonb_each(
                                COALESCE(definition -> 'advanced_config', '{}'::jsonb)
                            ) AS entry
                            WHERE entry.key IN ('effort', 'variant')
                                AND jsonb_typeof(entry.value) = 'string'
                        ),
                        '{}'::jsonb
                    )
                END
            )
        """
    )
