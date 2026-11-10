import { Alert, Box, Button, Chip, CircularProgress, Link } from "@mui/material";
import type { GridValidRowModel } from "@mui/x-data-grid";
import { type ReactNode, useEffect, useRef } from "react";
import { Link as RouterLink } from "react-router";
import { AccessChip } from "../../components/AccessControls";
import type { FilterOption, TableColumn } from "../../components/DataTable";
import PageBanner from "../../components/PageBanner";
import {
  ACCESS_LEVELS,
  ACCESS_META,
  type VisibilityPair,
  toAccessLevel,
} from "../../data/visibility";
import { EM_DASH, formatDate } from "../../theme/format";

/** The filter value for a resource with no owner. Not an id, which the Owner
 * column otherwise holds. */
const NO_OWNER = "no-owner";

/** Calls `refetch` each time `refreshKey` changes, but not on the first
 * render: the list loads itself when it mounts. The key last seen is kept,
 * rather than a "first run" flag, so StrictMode running the effect twice on
 * mount does not count as a change. */
export function useRefetchOnRefresh(refreshKey: number, refetch: () => unknown) {
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    void refetch();
    // Only a new key asks for a refetch; the callback is the current render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
}

interface Owned extends VisibilityPair {
  owner_id: string | null;
  owner_name: string | null;
}

/** Each owner the rows hold, by id, so two people of the same name stay two
 * options, plus "No owner" when a row has none. */
function ownerOptions(rows: readonly Owned[]): FilterOption[] {
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.owner_id) names.set(row.owner_id, row.owner_name ?? row.owner_id);
  }
  return [
    ...[...names.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    ...(rows.some((row) => !row.owner_id) ? [{ value: NO_OWNER, label: "No owner" }] : []),
  ];
}

/** The access levels the rows hold, in their order from private to public. */
function accessOptions(rows: readonly VisibilityPair[]): FilterOption[] {
  const held = new Set(rows.map(toAccessLevel));
  return ACCESS_LEVELS.filter((level) => held.has(level)).map((level) => ({
    value: level,
    label: ACCESS_META[level].label,
  }));
}

/** The name, as a link to the resource's page: the row opens it too, but a
 * link is reachable from the keyboard and opens in a new tab. */
export function nameColumn<T extends { id: string; name: string }>(
  pathFor: (row: T) => string,
): TableColumn<T> {
  return {
    field: "name",
    headerName: "Name",
    flex: 1,
    minWidth: 180,
    renderCell: ({ row, tabIndex }) => (
      <Link
        component={RouterLink}
        to={pathFor(row)}
        tabIndex={tabIndex}
        title={row.name}
        // The row opens it too; one navigation, not two.
        onClick={(event) => event.stopPropagation()}
        underline="hover"
        sx={{ fontWeight: 500, color: "text.primary", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {row.name}
      </Link>
    ),
  };
}

/** Cut to the column's width, with the whole text on hover. */
export function TruncatedText({ text }: { text: string }) {
  if (!text) return <Box component="span" sx={{ color: "text.secondary" }}>{EM_DASH}</Box>;
  return (
    <Box
      component="span"
      title={text}
      sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", color: "text.secondary" }}
    >
      {text}
    </Box>
  );
}

export function descriptionColumn<T extends { description: string }>(): TableColumn<T> {
  return {
    field: "description",
    headerName: "Description",
    flex: 2,
    minWidth: 220,
    sortable: false,
    renderCell: ({ row }) => <TruncatedText text={row.description} />,
  };
}

export function accessColumn<T extends VisibilityPair>(rows: readonly T[]): TableColumn<T> {
  return {
    field: "access",
    headerName: "Access",
    width: 120,
    valueGetter: (_value, row) => ACCESS_META[toAccessLevel(row)].label,
    filter: { value: (row) => toAccessLevel(row), options: accessOptions(rows) },
    renderCell: ({ row }) => <AccessChip pair={row} />,
  };
}

export function ownerColumn<T extends Owned>(rows: readonly T[]): TableColumn<T> {
  return {
    field: "owner_name",
    headerName: "Owner",
    width: 160,
    valueGetter: (_value, row) => row.owner_name ?? row.owner_id ?? "",
    filter: { value: (row) => row.owner_id ?? NO_OWNER, options: ownerOptions(rows) },
    renderCell: ({ value }) => <TruncatedOwner name={value as string} />,
  };
}

function TruncatedOwner({ name }: { name: string }) {
  if (!name) return EM_DASH;
  return (
    <Box component="span" title={name} sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
      {name}
    </Box>
  );
}

/** A count, left under its header like every other column, so a filterable
 * neighbour's menu button reads as its own. */
export function countColumn<T extends GridValidRowModel>(field: string, headerName: string, width: number): TableColumn<T> {
  return { field, headerName, width, type: "number", align: "left", headerAlign: "left" };
}

export function createdColumn<T extends { created_at: string | null }>(): TableColumn<T> {
  return {
    field: "created_at",
    headerName: "Created",
    // The title, the sort arrow the lists open with, and the menu button on
    // hover, without cutting the title short.
    width: 136,
    type: "date",
    valueGetter: (value) => (value ? new Date(value as string) : null),
    valueFormatter: (value) => formatDate(value as Date | null),
  };
}

/** A grey tag for a category, such as a reference's type: not a status, so
 * no colour. */
export function CategoryChip({ label }: { label: string }) {
  return <Chip label={label} size="small" sx={{ maxWidth: "100%" }} title={label} />;
}

/** Search over the name, description and owner, as each list offers. */
export function resourceSearchText(row: Owned & { name: string; description: string }): string {
  return [row.name, row.description, row.owner_name ?? ""].join(" ");
}

/** The list once loaded, the reason it could not be, or a spinner until one
 * or the other. A failed refresh keeps the list as last loaded, under a
 * warning that says so. */
export function ListBody({
  what,
  loaded,
  error,
  loading,
  onRetry,
  children,
}: {
  /** The plural noun for the messages: "references". */
  what: string;
  loaded: boolean;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const retry = (
    <Button color="inherit" size="small" onClick={onRetry}>
      Retry
    </Button>
  );
  if (!loaded && loading) return <CircularProgress aria-label={`Loading ${what}`} />;
  if (!loaded) {
    return (
      <Alert severity="error" action={retry}>
        Couldn't load the {what}: {error}
      </Alert>
    );
  }
  return (
    <>
      {error && (
        <Box sx={{ mb: 2 }}>
          <PageBanner tone="warning" action={retry}>
            Couldn't refresh the {what}: {error}. This is the list as last loaded.
          </PageBanner>
        </Box>
      )}
      {children}
    </>
  );
}
