"""decision_settings.backend: self_hosted and gemini

Two more choices a workspace can save in Settings → Message routing, both run
in the server's decision service: `self_hosted` (the model the service runs
on its own model server) and `gemini` (Gemini, with the fallback the service
applies to it). The CHECK on `backend` is dropped and created again with
them.

Expand only: a release from before this revision never writes either value.
One that reads a row a newer replica wrote with one of them, during the
rollout, does not know it: its settings page for that workspace fails, and
that workspace's untagged messages get no decision there (nobody, or the
room's triage agent), until the rollout finishes. Releases from this one on
treat a value they do not know as auto-route off in that workspace, with a
warning.

Downgrading deletes the rows that chose either, so those workspaces go back
to the server default.

Revision ID: c18f5ebeef66
Revises: f3a9c1d7e2b4
Create Date: 2026-11-20 16:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c18f5ebeef66"
down_revision: str | None = "f3a9c1d7e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_CHECK = "ck_decision_settings_backend"


def upgrade() -> None:
    op.drop_constraint(_CHECK, "decision_settings", type_="check")
    op.create_check_constraint(
        _CHECK,
        "decision_settings",
        "backend IN ('none', 'endpoint', 'haiku_anthropic', 'haiku_bedrock', "
        "'self_hosted', 'gemini')",
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM decision_settings WHERE backend IN ('self_hosted', 'gemini')"
    )
    op.drop_constraint(_CHECK, "decision_settings", type_="check")
    op.create_check_constraint(
        _CHECK,
        "decision_settings",
        "backend IN ('none', 'endpoint', 'haiku_anthropic', 'haiku_bedrock')",
    )
