import type { GridColDef } from "@mui/x-data-grid";
import type { ReactNode } from "react";

type Row = Record<string, unknown>;

/** A cell's text as the grid would show it: through `valueGetter`, then
 * `valueFormatter`. */
function cellText(column: GridColDef<Row>, row: Row): string {
  const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
  let value: unknown = row[column.field];
  if (column.valueGetter) value = call(column.valueGetter, value, row, column, null);
  if (column.valueFormatter) value = call(column.valueFormatter, value, row, column, null);
  return String(value ?? "");
}

/** Stands in for `components/DataTable` in tests: the data grid lays rows out
 * from measured sizes, which jsdom does not have, so it renders none. This
 * draws every row's cells plainly, as the grid would show them. */
export default function FakeDataTable({
  rows,
  columns,
  emptyState,
}: {
  rows: Row[];
  columns: GridColDef<Row>[];
  emptyState?: ReactNode;
}) {
  return (
    <div>
      {rows.length === 0 && emptyState}
      {rows.map((row) => (
        <div key={String(row.id)} data-testid={`row-${String(row.id)}`}>
          {columns.map((column) => (
            <span key={column.field}>
              {column.renderCell ? column.renderCell({ row } as never) : cellText(column, row)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The real one's text, without its layout. */
export function TableEmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <p>{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}
