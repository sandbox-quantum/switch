"""move generated agent icons from DiceBear bottts to gaze

Revision ID: 2f6919dcdead
Revises: fabf9b9bff78

Generated agent icons used to be DiceBear's 9.x "bottts" robot and are now its
10.x "gaze" style. An agent's icon is stored as a URL, so the agents that were
given a robot keep it until the stored URL changes; this rewrites each one to
the gaze icon drawn from the same seed. The seed is carried over exactly as
stored, already escaped, so it draws for the same input it did before.

Only the robot URL Switch and Switch Console generated is touched. An icon on
any other host, or any other DiceBear style, was chosen by someone and is left
as it is. A robot URL with no seed (none were generated that way) is drawn
from the agent's name, as an agent with no icon is.

The gaze URL is written out here rather than built by
`switch_core.agent_icon.generated_icon_url`: a migration has to keep producing
what it produced on the day it shipped, whatever that function becomes later.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "2f6919dcdead"
down_revision: str | Sequence[str] | None = "fabf9b9bff78"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_GAZE_QUERY_AFTER_SEED = (
    "&size=256&scale=1.1"
    "&shapeVariant=circle&shapeVariant=column&shapeVariant=diamond"
    "&shapeVariant=egg&shapeVariant=hexagon&shapeVariant=octagon"
    "&shapeVariant=pentagon&shapeVariant=pill&shapeVariant=square"
    "&shapeVariant=triangle"
)

# The stored seed, or the agent's name when the URL carries none. Agent names
# are limited to characters a query string needs no escaping for.
_SEED = "COALESCE(NULLIF(substring(icon_url from '[?&]seed=([^&#]*)'), ''), name)"


def upgrade() -> None:
    # Runs as the schema owner, which row-level security does not restrict, so
    # every tenant's agents are seen.
    op.execute(
        f"""
        UPDATE agents
        SET icon_url = 'https://api.dicebear.com/10.x/gaze/png?seed='
            || {_SEED} || '{_GAZE_QUERY_AFTER_SEED}'
        WHERE icon_url ~ '^https://api\\.dicebear\\.com/9\\.x/bottts/png([?#]|$)'
        """
    )


def downgrade() -> None:
    # Every gaze icon goes back to the robot for its seed, including ones given
    # to agents after the upgrade: the code this returns to draws only robots,
    # so a gaze icon would be the one face it never generates.
    op.execute(
        f"""
        UPDATE agents
        SET icon_url = 'https://api.dicebear.com/9.x/bottts/png?seed='
            || {_SEED} || '&size=256'
        WHERE icon_url ~ '^https://api\\.dicebear\\.com/10\\.x/gaze/png([?#]|$)'
        """
    )
