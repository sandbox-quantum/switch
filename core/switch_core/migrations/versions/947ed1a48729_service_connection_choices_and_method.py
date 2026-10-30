"""service connection choices and method, and a registered client per choice

`service_connections.choices`: what the person picked from the catalog
entry's fixed lists before signing in (a vendor's site), by name, so every
URL called for the connection is the one for its choice. `{}` for every
connection made so far: no entry offered a choice.

`service_connections.method`: how the person connected, `oauth` (a
sign-in), `token` (a pasted token) or `keys` (pasted keys). Every
connection made so far signed in, except Datadog's, which pasted its API
and application keys: it was the one entry connected with keys before
this revision.

`service_oauth_clients` is keyed by service and choice, since a vendor at
several sites registers a client at each. Every row so far is a service's
one client, under the empty choice.

Expand only: a release from before this revision never reads the new
columns, and inserts a connection or a registered client without them,
which the defaults fill as it means them. It reads and writes registered
clients by service alone, for entries that offer no choice, whose one row
each stays under the empty choice. Downgrading drops what was kept for
any other choice; the server registers again on the next connect.

Revision ID: 947ed1a48729
Revises: e5a9c3d71f08
Create Date: 2026-10-29 22:00:05.070908

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "947ed1a48729"
down_revision: str | None = "e5a9c3d71f08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_METHOD_CHECK = "ck_service_connections_method"
_CLIENTS_KEY = "service_oauth_clients_pkey"


def upgrade() -> None:
    op.add_column(
        "service_connections",
        sa.Column(
            "choices",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "service_connections",
        sa.Column("method", sa.Text(), server_default="oauth", nullable=False),
    )
    op.execute(
        "UPDATE service_connections SET method = 'keys' WHERE service = 'datadog'"
    )
    op.create_check_constraint(
        _METHOD_CHECK, "service_connections", "method IN ('oauth', 'token', 'keys')"
    )
    op.add_column(
        "service_oauth_clients",
        sa.Column("choice", sa.Text(), server_default="", nullable=False),
    )
    op.drop_constraint(_CLIENTS_KEY, "service_oauth_clients", type_="primary")
    op.create_primary_key(_CLIENTS_KEY, "service_oauth_clients", ["service", "choice"])


def downgrade() -> None:
    op.execute("DELETE FROM service_oauth_clients WHERE choice <> ''")
    op.drop_constraint(_CLIENTS_KEY, "service_oauth_clients", type_="primary")
    op.drop_column("service_oauth_clients", "choice")
    op.create_primary_key(_CLIENTS_KEY, "service_oauth_clients", ["service"])
    op.drop_constraint(_METHOD_CHECK, "service_connections", type_="check")
    op.drop_column("service_connections", "method")
    op.drop_column("service_connections", "choices")
