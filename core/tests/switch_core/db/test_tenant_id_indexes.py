"""Every tenant table has an index whose first column is `tenant_id`.

The row-level-security policy filters every table on `tenant_id`, queries
across one tenant's rows ask by it, and deleting a tenant checks each table's
foreign key to it. Without an index leading with that column each of those is
a scan of the whole table, every tenant's rows included. A partial index does
not count: it serves only the rows its predicate admits.
"""

from __future__ import annotations

from sqlalchemy import PrimaryKeyConstraint, Table, UniqueConstraint

import switch_core.db.models  # noqa: F401 — registers every table on Base.metadata
from switch_core.db.base import Base


def _leads_with_tenant_id(table: Table) -> bool:
    for index in table.indexes:
        columns = list(index.columns)
        if (
            columns
            and columns[0].name == "tenant_id"
            and index.dialect_options["postgresql"].get("where") is None
        ):
            return True
    for constraint in table.constraints:
        if isinstance(constraint, UniqueConstraint | PrimaryKeyConstraint):
            columns = list(constraint.columns)
            if columns and columns[0].name == "tenant_id":
                return True
    return False


def test_every_tenant_table_has_an_index_leading_with_tenant_id() -> None:
    missing = sorted(
        table.name
        for table in Base.metadata.tables.values()
        if "tenant_id" in table.c and not _leads_with_tenant_id(table)
    )

    assert missing == []
