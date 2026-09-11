"""drop tenant_of_client, the one lookup its callers never needed

`9c41a7b0e5d8` installed eight `SECURITY DEFINER` functions as the whole
exemption from row-level security. This drops one of them.

`tenant_of_client(client_id)` answered "which tenant is this room client in",
and it was the most-called of the eight: once per transport, on every client
in the process, plus once more in `AgentClient.start`. Both callers were
handed a `clients` row to begin with — `ClientFactory.create(record)` builds
the client, and `record.tenant_id` is a column on that row — so the question
went to the database with the answer already in hand. `ClientBase` and
`PostgresTransport` now take a `tenant_id` alongside the `client_id` they
already took, and nothing calls the function.

Dropping it rather than leaving it installed is the point of the change.
Every function in this set is callable by whoever holds the runtime role's
credentials, and it answers a question about a tenant boundary; one that no
code needs is still one an operator would have to audit, and the argument for
the exemption is that its inventory is short enough to read. A lookup called
on every transport is the one worth not having.

The downgrade recreates it, verbatim as `9c41a7b0e5d8` wrote it, so a rollback
past this revision lands on a schema that revision would recognise.

Revision ID: b1d7c4f0a92e
Revises: 9c41a7b0e5d8
Create Date: 2026-09-10 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b1d7c4f0a92e"
down_revision: str | None = "9c41a7b0e5d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen, like everything else in this chain: the text `9c41a7b0e5d8` ran, so
# a downgrade puts back exactly what it created rather than whatever
# `db/tenant_lookup.py` would build today — which, this revision having
# landed, would build nothing at all.
SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_CLIENT = f"""CREATE OR REPLACE FUNCTION tenant_of_client(p_client_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM clients WHERE id = p_client_id$$"""

DROP_TENANT_OF_CLIENT = "DROP FUNCTION IF EXISTS tenant_of_client(text)"


def upgrade() -> None:
    op.execute(DROP_TENANT_OF_CLIENT)


def downgrade() -> None:
    op.execute(CREATE_TENANT_OF_CLIENT)
