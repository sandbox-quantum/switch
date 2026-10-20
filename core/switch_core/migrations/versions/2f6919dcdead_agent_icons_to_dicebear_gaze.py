"""move generated agent icons from DiceBear bottts to gaze

Revision ID: 2f6919dcdead
Revises: fabf9b9bff78

Generated agent icons used to be DiceBear's 9.x "bottts" robot and are now its
10.x "gaze" style. An agent's icon is stored as a URL, so the agents that were
given a robot keep it until the stored URL changes; this rewrites each one to
the gaze icon drawn from the same seed. The seed is carried over exactly as
stored, already escaped, so it draws for the same input it did before.

Only the robot URL Switch and Switch Console generated is touched, matched in
exactly the shape they built it: a seed and `size=256`, nothing more. An icon on
any other host, any other DiceBear style, or a robot URL carrying options of its
own was chosen by someone and is left as it is. Downgrade is held to the same
line, turning back only the gaze URL in exactly the shape this writes. Saving an
icon applies the same pattern (`agent_icon.upgrade_legacy_icon_url`), so what
this leaves as a robot stays one when saved.

The gaze URL is longer than the robot it replaces. A robot whose gaze form would
exceed the 2048 characters Switch accepts for an icon is left as it is rather
than stored over the limit; saving one is refused for the same reason.

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

_ROBOT = "https://api.dicebear.com/9.x/bottts/png?seed="
_GAZE = "https://api.dicebear.com/10.x/gaze/png?seed="

_GAZE_QUERY_AFTER_SEED = "&size=256&scale=1.1"

# The whole stored URL has to be the generated robot, so the pattern is
# anchored at both ends and the seed is the only part allowed to vary.
_ROBOT_SEED = r"'^https://api\.dicebear\.com/9\.x/bottts/png\?seed=([^&#]+)&size=256$'"
# A gaze URL's seed, checked afterwards against the full generated shape.
_GAZE_SEED = r"'^https://api\.dicebear\.com/10\.x/gaze/png\?seed=([^&#]+)&'"


# `agent_icon.MAX_ICON_URL_LENGTH` on the day this shipped.
_MAX_ICON_URL_LENGTH = 2048


def upgrade() -> None:
    gaze = f"'{_GAZE}' || substring(icon_url from {_ROBOT_SEED}) || '{_GAZE_QUERY_AFTER_SEED}'"
    # Runs as the schema owner, which row-level security does not restrict, so
    # every tenant's agents are seen.
    op.execute(
        f"""
        UPDATE agents
        SET icon_url = {gaze}
        WHERE icon_url ~ {_ROBOT_SEED}
          AND length({gaze}) <= {_MAX_ICON_URL_LENGTH}
        """
    )


def downgrade() -> None:
    # Every generated gaze icon goes back to the robot for its seed, including
    # ones given to agents after the upgrade: the code this returns to draws
    # only robots, so a gaze icon would be the one face it never generates.
    op.execute(
        f"""
        UPDATE agents
        SET icon_url = '{_ROBOT}'
            || substring(icon_url from {_GAZE_SEED}) || '&size=256'
        WHERE icon_url = '{_GAZE}'
            || substring(icon_url from {_GAZE_SEED}) || '{_GAZE_QUERY_AFTER_SEED}'
        """
    )
