"""drop older links to accounts many people post as

`3b81c0e5d9a7` made links wait for the account to confirm them and kept the
ones that already existed working, unverified. Some of those are on accounts
that from now on cannot be linked to anyone: Telegram's stand-ins for anonymous
group admins, for posts made as a channel and for its own service account, and
Slack's app and bot ids. Each recognises everyone posting as that account as
the claimant, and none could ever be confirmed, so this revision deletes them
rather than leave them counting. It deletes any link to one of them still
waiting for its code as well (an admin's "require confirmation" makes one of
an older link): none of those could be confirmed either, and a code issued
for one before this revision would otherwise go on working until it expired.

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

# The accounts many people post as, by the id alone.
SHARED_ACCOUNTS = """
SELECT account.id
FROM external_users AS account
JOIN collaboration_bridges AS bridge ON bridge.id = account.bridge_id
WHERE (bridge.type = 'telegram'
       AND account.external_user_id IN ('1087968824', '136817688', '777000'))
   OR (bridge.type = 'slack'
       AND (account.external_user_id = 'USLACKBOT'
            OR account.external_user_id ~ '^B[A-Z0-9]+$'))
"""

# Requests first, the order a confirmation takes the two tables in.
PURGE_SHARED_ACCOUNT_REQUESTS = f"""
DELETE FROM external_user_link_requests
WHERE external_user_id IN ({SHARED_ACCOUNTS})
"""

PURGE_SHARED_ACCOUNT_CLAIMS = f"""
DELETE FROM external_user_claims
WHERE verified_at IS NULL
  AND external_user_id IN ({SHARED_ACCOUNTS})
"""


def upgrade() -> None:
    op.execute(PURGE_SHARED_ACCOUNT_REQUESTS)
    op.execute(PURGE_SHARED_ACCOUNT_CLAIMS)


def downgrade() -> None:
    # The links deleted were never confirmable; nothing to put back.
    pass
