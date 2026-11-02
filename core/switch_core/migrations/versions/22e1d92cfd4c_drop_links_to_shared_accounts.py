"""drop older links to accounts many people post as

`3b81c0e5d9a7` made links wait for the account to confirm them and kept the
ones that already existed working, unverified. Some of those are on accounts
that from now on cannot be linked to anyone: Telegram's stand-ins for anonymous
group admins, for posts made as a channel and for its own service account, and
Slack's app and bot ids. Each recognises everyone posting as that account as
the claimant, and none could ever be confirmed, so this revision deletes them
rather than leave them counting.

The ids are copied from the adapters as they stood (the Telegram and Slack
`unlinkable_account_reason`), not imported, so a later edit to an adapter
cannot change what this revision did. A bot that Slack files under a `U…` id,
like Discord's and Mattermost's bots, takes asking the platform; those older
links are left to the confirmation flow, which refuses them and removes the
link when their owner asks for a code. Nothing restores them on downgrade.

Expand only: it deletes rows, and a release from before it reads the table as
it always did.

Revision ID: 22e1d92cfd4c
Revises: 3b81c0e5d9a7
Create Date: 2026-11-02 18:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "22e1d92cfd4c"
down_revision: str | None = "3b81c0e5d9a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

PURGE_SHARED_ACCOUNT_CLAIMS = """
DELETE FROM external_user_claims AS claim
USING external_users AS account, collaboration_bridges AS bridge
WHERE claim.external_user_id = account.id
  AND account.bridge_id = bridge.id
  AND claim.verified_at IS NULL
  AND (
    (bridge.type = 'telegram'
     AND account.external_user_id IN ('1087968824', '136817688', '777000'))
    OR (bridge.type = 'slack'
        AND (account.external_user_id = 'USLACKBOT'
             OR account.external_user_id ~ '^B[A-Z0-9]+$'))
  )
"""


def upgrade() -> None:
    op.execute(PURGE_SHARED_ACCOUNT_CLAIMS)


def downgrade() -> None:
    # The links deleted were never confirmable; nothing to put back.
    pass
