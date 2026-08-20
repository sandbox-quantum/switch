import type { ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * The shell a server's list pages sit in — the same column width and header
 * shape as the server's Home, so moving between the three does not move the
 * title or resize the content under you.
 */
export function ServerPage({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  /** Header-level action, where the page has one. Agents has none: its add
   * affordance is the first tile of its grid. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-foreground-muted">{description}</p>
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export type ServerTableColumn = {
  key: string;
  label: string;
  /** Width and alignment for this column, e.g. `w-28 text-right`. */
  className?: string;
};

/**
 * A page-level table, matching the messaging apps table on the server's Home.
 *
 * `table-fixed` with widths on the trailing columns is what keeps the actions
 * against the right edge whatever the names in the first column are, so two
 * such tables on different pages line up rather than each finding their own
 * column widths from their own content.
 */
export function ServerTable({
  columns,
  children,
}: {
  columns: readonly ServerTableColumn[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-background-secondary text-xs text-foreground-muted">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn('px-3 py-2 text-left font-normal', column.className)}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

/** The empty case for one of those tables: the border stays, the rows do not. */
export function ServerTableEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border px-3 py-8 text-center text-sm text-foreground-muted">
      {children}
    </div>
  );
}
