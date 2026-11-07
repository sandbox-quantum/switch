import FilterListOutlined from "@mui/icons-material/FilterListOutlined";
import SearchOutlined from "@mui/icons-material/SearchOutlined";
import {
  DataGrid,
  type GridColDef,
  type GridColumnMenuItemProps,
  type GridOverlayProps,
  type GridRowId,
  type GridRowParams,
  type GridRowSelectionModel,
  type GridValidRowModel,
  useGridApiRef,
} from "@mui/x-data-grid";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Popover,
  Stack,
  type SxProps,
  TextField,
  type Theme,
  ToggleButton,
  Typography,
} from "@mui/material";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import {
  applyFilters,
  type ColumnFilter,
  countLabel,
  type FilterSelection,
  filterOptions,
  isQuickFilterOn,
  type QuickFilter,
  type TableNoun,
  toggleQuickFilter,
  toggleValue,
} from "./tableFilters";

export type { ColumnFilter, QuickFilter, TableNoun } from "./tableFilters";

/** A grid column, plus how its header menu filters it. */
export type TableColumn<T extends GridValidRowModel> = GridColDef<T> & { filter?: ColumnFilter<T> };

declare module "@mui/x-data-grid" {
  interface NoRowsOverlayPropsOverrides {
    tableEmpty?: ReactNode;
  }
}

interface DataTableProps<T extends { id: string | number }> {
  rows: T[];
  columns: TableColumn<T>[];
  height?: number;
  // When true, the table grows to fill its (flex-column) parent instead of
  // using a fixed `height`. The parent must be a flex column with a bounded
  // height (e.g. a page laid out with flexGrow + minHeight: 0).
  fillHeight?: boolean;
  pageSize?: number;
  checkboxSelection?: boolean;
  // Rows that may be ticked, when not every one may (the viewer cannot act
  // on the rest).
  isRowSelectable?: (row: T) => boolean;
  onRowSelectionModelChange?: (ids: GridRowId[]) => void;
  onRowClick?: (params: GridRowParams<T>) => void;
  sx?: SxProps<Theme>;
  /** What a row is, for the count above the table ("12 agents", "3 of 12
   *  agents" while filtered). Without it there is no count. */
  noun?: TableNoun;
  /** A search box over the text `text` returns for each row. */
  search?: { label: string; text: (row: T) => string };
  /** One-click shortcuts for a single value of a filterable column. */
  quickFilters?: QuickFilter[];
  /** Fields held against the right edge while the other columns scroll,
   *  usually the row's actions. Each needs a fixed `width`, and they render
   *  last, in this order. */
  pinnedRight?: string[];
  /** Shown when there are no rows at all, as opposed to none matching the
   *  filters. Word it for the viewer: "No agents in this workspace yet" for
   *  an admin, "You don't own any agents" for a member. */
  emptyState?: ReactNode;
}

/** Hoot's grid treatment: a bordered 16px-radius surface with a cream header
 *  band, generous 52px rows, and tabular figures so numeric columns line up.
 *  Ported from the Hoot design system's DataTable. */
const HOOT_GRID_SX: SxProps<Theme> = {
  border: "1px solid var(--hoot-border)",
  borderRadius: "16px",
  "--DataGrid-rowBorderColor": "var(--hoot-border)",
  // The band is painted on the header row and the cells let it through: the
  // grid paints each header cell with its own opaque background otherwise.
  "& .MuiDataGrid-columnHeaders": { backgroundColor: "var(--hoot-cream)" },
  "& .MuiDataGrid-columnHeader, & .MuiDataGrid-columnHeaders .MuiDataGrid-filler": {
    backgroundColor: "transparent",
  },
  "& .MuiDataGrid-columnHeader": {
    fontSize: "0.875rem",
    fontWeight: 500,
    letterSpacing: "-0.01em",
  },
  "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 500, opacity: 0.7 },
  "& .MuiDataGrid-row": { minHeight: "52px !important" },
  "& .MuiDataGrid-row:hover": { backgroundColor: "var(--hoot-accent)" },
  "& .MuiDataGrid-row.Mui-selected": {
    backgroundColor: "var(--hoot-muted)",
    "&:hover": { backgroundColor: "var(--hoot-muted)" },
  },
  "& .MuiDataGrid-cell": {
    minHeight: 52,
    fontSize: "0.9375rem",
    fontVariantNumeric: "tabular-nums",
    borderTopColor: "var(--hoot-border)",
  },
  "& .MuiDataGrid-footerContainer": {
    backgroundColor: "var(--hoot-cream)",
    borderTopColor: "var(--hoot-border)",
    borderBottomLeftRadius: "16px",
    borderBottomRightRadius: "16px",
  },
  "& .MuiDataGrid-columnSeparator": { display: "none" },
  "& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within, & .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within":
    { outline: "2px solid var(--hoot-ring)", outlineOffset: "-2px" },
  "& .MuiDataGrid-overlay": {
    fontSize: "0.875rem",
    color: "var(--hoot-muted-foreground)",
    backgroundColor: "transparent",
  },
};

/** A table that filters its own rows keeps each header's menu button in view,
 *  faintly, since that menu is where its columns are filtered. */
const OWN_FILTERING_SX: SxProps<Theme> = {
  "& .MuiDataGrid-menuIcon": { visibility: "visible", width: "auto", opacity: 0.5 },
  "& .MuiDataGrid-columnHeader:hover .MuiDataGrid-menuIcon": { opacity: 1 },
};

const PINNED = "hoot-pinned-right";

/** The free grid has no column pinning, so a pinned column is a sticky one:
 *  the scrolling columns pass under it, which needs an opaque fill that
 *  follows the row's hover and selection, and a hairline on its left edge.
 *  The header's cream is a wash, so it is laid over the card fill to match
 *  the unpinned header cells. */
const PINNED_SX: SxProps<Theme> = {
  [`& .${PINNED}`]: {
    position: "sticky",
    zIndex: 1,
    backgroundColor: "var(--hoot-card)",
    boxShadow: "inset 1px 0 0 var(--hoot-border)",
  },
  [`& .MuiDataGrid-columnHeader.${PINNED}`]: {
    background: "linear-gradient(var(--hoot-cream), var(--hoot-cream)), var(--hoot-card)",
  },
  [`& .MuiDataGrid-row:hover .${PINNED}`]: { backgroundColor: "var(--hoot-accent)" },
  [`& .MuiDataGrid-row.Mui-selected .${PINNED}`]: { backgroundColor: "var(--hoot-muted)" },
};

const appendClass = <T extends GridValidRowModel>(
  existing: GridColDef<T>["cellClassName"] | GridColDef<T>["headerClassName"],
  extra: string,
) => {
  if (typeof existing === "function") {
    return (params: never) => `${(existing as (p: never) => string)(params)} ${extra}`;
  }
  return existing ? `${existing} ${extra}` : extra;
};

/** The columns as the grid takes them: our `filter` stripped, and pinned
 *  columns moved last with their sticky offsets. When the table filters its
 *  own rows, a column is filterable exactly when it has a `filter`; otherwise
 *  columns keep the grid's own filtering, as tables without a toolbar do. */
function gridColumns<T extends GridValidRowModel>(
  columns: TableColumn<T>[],
  pinnedRight: string[],
  ownFiltering: boolean,
): { columns: GridColDef<T>[]; offsets: Record<string, number> } {
  const byField = new Map(columns.map((column) => [column.field, column]));
  const pinned = pinnedRight.map((field) => {
    const column = byField.get(field);
    if (!column) throw new Error(`pinnedRight names "${field}", which is not a column`);
    if (typeof column.width !== "number") throw new Error(`pinned column "${field}" needs a fixed width`);
    return column;
  });

  const offsets: Record<string, number> = {};
  let right = 0;
  for (const column of [...pinned].reverse()) {
    offsets[column.field] = right;
    right += column.width as number;
  }

  const toGrid = ({ filter, ...column }: TableColumn<T>): GridColDef<T> => {
    const base = (ownFiltering ? { ...column, filterable: Boolean(filter) } : column) as GridColDef<T>;
    if (!(column.field in offsets)) return base;
    return {
      ...base,
      resizable: false,
      headerClassName: appendClass(column.headerClassName, PINNED),
      cellClassName: appendClass(column.cellClassName, PINNED),
    } as GridColDef<T>;
  };

  return {
    columns: [...columns.filter((column) => !(column.field in offsets)), ...pinned].map(toGrid),
    offsets,
  };
}

/** Lets the header menu's Filter item, which the grid renders, open the
 *  table's own filter picker. Null when the table leaves filtering to the
 *  grid, whose own Filter item then shows instead. */
const TableFilterContext = createContext<{ fields: Set<string>; open: (field: string) => void } | null>(null);

function FilterMenuItem(props: GridColumnMenuItemProps) {
  const { colDef, onClick } = props;
  const table = useContext(TableFilterContext);
  if (!table || !table.fields.has(colDef.field)) return null;
  return (
    <MenuItem
      onClick={(event) => {
        onClick(event);
        table.open(colDef.field);
      }}
    >
      <ListItemIcon>
        <FilterListOutlined fontSize="small" />
      </ListItemIcon>
      <ListItemText>Filter</ListItemText>
    </MenuItem>
  );
}

/** The grid drops its own Filter item when its filtering is off, so ours is
 *  added to the stock column menu under its own key, in the place the grid's
 *  would take. Given through `slotProps` rather than a wrapper component, so
 *  the grid still recognises its own menu when deciding whether a header has
 *  a menu to show. */
const TABLE_COLUMN_MENU = {
  slots: { columnMenuTableFilterItem: FilterMenuItem },
  slotProps: { columnMenuTableFilterItem: { displayOrder: 20 } },
};

function TableOverlay({ tableEmpty }: GridOverlayProps & { tableEmpty?: ReactNode }) {
  return (
    <Stack sx={{ height: "100%", alignItems: "center", justifyContent: "center", p: 3, textAlign: "center" }}>
      {tableEmpty}
    </Stack>
  );
}

export default function DataTable<T extends { id: string | number }>({
  rows,
  columns,
  height = 600,
  fillHeight = false,
  pageSize = 25,
  checkboxSelection = false,
  isRowSelectable,
  onRowSelectionModelChange,
  onRowClick,
  sx,
  noun,
  search,
  quickFilters = [],
  pinnedRight = [],
  emptyState,
}: DataTableProps<T>) {
  const apiRef = useGridApiRef();
  const [selection, setSelection] = useState<FilterSelection>({});
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState<{ field: string; anchor: HTMLElement } | null>(null);

  const filterable = useMemo(() => columns.filter((column) => column.filter), [columns]);
  for (const quick of quickFilters) {
    if (!filterable.some((column) => column.field === quick.field)) {
      throw new Error(`quick filter "${quick.label}" names column "${quick.field}", which has no filter`);
    }
  }

  const hasToolbar = Boolean(noun || search || quickFilters.length > 0);
  const ownFiltering = hasToolbar || filterable.length > 0;
  const grid = useMemo(
    () => gridColumns(columns, pinnedRight, ownFiltering),
    [columns, pinnedRight, ownFiltering],
  );
  const shown = useMemo(
    () => applyFilters(rows, columns, selection, query, search?.text),
    [rows, columns, selection, query, search],
  );

  const searching = query.trim() !== "";
  const picking = Object.keys(selection).length > 0;
  const narrowed = searching || picking;
  const clearFilters = () => {
    setSelection({});
    setQuery("");
  };
  const openFilter = (field: string) => {
    const anchor = apiRef.current?.getColumnHeaderElement(field);
    if (!anchor) throw new Error(`no header element for column "${field}"`);
    setPicker({ field, anchor });
  };

  const empty =
    rows.length === 0 ? (
      emptyState
    ) : (
      <>
        <Typography variant="body2" color="text.secondary">
          {noun ? `No ${noun.other} match the current filters.` : "Nothing matches the current filters."}
        </Typography>
        <Button size="small" onClick={clearFilters} sx={{ mt: 1 }}>
          {searching && picking ? "Clear search and filters" : searching ? "Clear search" : "Clear filters"}
        </Button>
      </>
    );

  const chips = filterable.flatMap((column) => {
    const picked = selection[column.field] ?? [];
    if (picked.length === 0) return [];
    const labels = new Map(filterOptions(column, rows).map((option) => [option.value, option.label]));
    return picked.map((value) => (
      <Chip
        key={`${column.field}:${value}`}
        variant="outlined"
        label={`${column.headerName ?? column.field}: ${labels.get(value) ?? value}`}
        onDelete={() => setSelection((current) => toggleValue(current, column.field, value))}
      />
    ));
  });

  // Tables that leave filtering to the grid keep its own overlays.
  const tableOverlay = emptyState !== undefined || (ownFiltering && rows.length > 0);
  const pickerColumn = picker ? filterable.find((column) => column.field === picker.field) : undefined;
  const pinnedSx = pinnedRight.length > 0 ? [PINNED_SX, pinnedOffsetsSx(grid.offsets)] : [];
  const extraSx = Array.isArray(sx) ? sx : sx ? [sx] : [];

  const table = (
    <DataGrid
      apiRef={apiRef}
      rows={shown}
      columns={grid.columns}
      initialState={{
        pagination: { paginationModel: { pageSize } },
      }}
      pageSizeOptions={[10, 25, 50]}
      pagination
      checkboxSelection={checkboxSelection}
      isRowSelectable={
        isRowSelectable ? (params: GridRowParams<T>) => isRowSelectable(params.row) : undefined
      }
      onRowSelectionModelChange={
        onRowSelectionModelChange
          ? (model: GridRowSelectionModel) => onRowSelectionModelChange([...model.ids])
          : undefined
      }
      onRowClick={onRowClick}
      disableRowSelectionOnClick
      // A sticky column only sticks while it is rendered, so with one pinned
      // every column renders rather than only those scrolled into view.
      columnBufferPx={pinnedRight.length > 0 ? 1_000_000 : undefined}
      disableColumnFilter={ownFiltering}
      slots={tableOverlay ? { noRowsOverlay: TableOverlay } : undefined}
      slotProps={{
        ...(tableOverlay && { noRowsOverlay: { tableEmpty: empty } }),
        ...(ownFiltering && { columnMenu: TABLE_COLUMN_MENU }),
      }}
      sx={[
        HOOT_GRID_SX,
        ...(ownFiltering ? [OWN_FILTERING_SX] : []),
        ...pinnedSx,
        { height: fillHeight ? "100%" : height },
        ...extraSx,
      ]}
    />
  );

  return (
    <TableFilterContext.Provider
      value={ownFiltering ? { fields: new Set(filterable.map((column) => column.field)), open: openFilter } : null}
    >
      {/* The grid's root is a flex item that grows (`flex: 1`), so inside a
          flex column it would ignore a fixed `height` and size to its rows.
          Only a table that fills its parent is laid out as one. */}
      <Box sx={fillHeight ? { flex: 1, minHeight: 0, width: "100%", display: "flex", flexDirection: "column" } : { width: "100%" }}>
        {hasToolbar && (
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mb: 2 }}>
            {noun && (
              <Typography variant="subtitle2" component="p" aria-live="polite" sx={{ flexShrink: 0 }}>
                {countLabel(shown.length, rows.length, noun, narrowed)}
              </Typography>
            )}
            {quickFilters.map((quick) => (
              <ToggleButton
                key={`${quick.field}:${quick.value}`}
                value={quick.value}
                size="small"
                selected={isQuickFilterOn(selection, quick)}
                onChange={() => setSelection((current) => toggleQuickFilter(current, quick))}
                sx={QUICK_FILTER_SX}
              >
                {quick.label}
              </ToggleButton>
            ))}
            {search && (
              <TextField
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={search.label}
                fullWidth={false}
                slotProps={{
                  htmlInput: { "aria-label": search.label },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchOutlined fontSize="small" />
                      </InputAdornment>
                    ),
                  },
                }}
                sx={{ width: 224 }}
              />
            )}
          </Stack>
        )}
        {chips.length > 0 && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
            {chips}
            <Button size="small" onClick={() => setSelection({})}>
              Clear filters
            </Button>
          </Stack>
        )}
        {fillHeight ? <Box sx={{ flex: 1, minHeight: 0 }}>{table}</Box> : table}
      </Box>
      {picker && pickerColumn && (
        <Popover
          open
          anchorEl={picker.anchor}
          onClose={() => setPicker(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
          slotProps={{ paper: { sx: { p: 1.5, minWidth: 220, maxHeight: 360 } } }}
        >
          <Typography variant="overline" color="text.secondary" component="p" sx={{ px: 1 }}>
            Filter by {pickerColumn.headerName ?? pickerColumn.field}
          </Typography>
          <Stack>
            {filterOptions(pickerColumn, rows).map((option) => (
              <FormControlLabel
                key={option.value}
                sx={{ mx: 0, px: 1, borderRadius: 1.5, "&:hover": { backgroundColor: "var(--hoot-accent)" } }}
                control={
                  <Checkbox
                    size="small"
                    checked={(selection[pickerColumn.field] ?? []).includes(option.value)}
                    onChange={() =>
                      setSelection((current) => toggleValue(current, pickerColumn.field, option.value))
                    }
                  />
                }
                label={<Typography variant="body2">{option.label}</Typography>}
              />
            ))}
          </Stack>
        </Popover>
      )}
    </TableFilterContext.Provider>
  );
}

/** Quick filters share a text field's 36px height and hairline so the toolbar
 *  reads as one strip; pressed is a quiet wash, not a status colour. */
const QUICK_FILTER_SX: SxProps<Theme> = {
  height: 36,
  px: 1.5,
  borderRadius: "8px",
  borderColor: "var(--hoot-field-border)",
  color: "var(--hoot-foreground)",
  fontSize: "0.875rem",
  fontWeight: 500,
  textTransform: "none",
  "&.Mui-selected, &.Mui-selected:hover": {
    backgroundColor: "var(--hoot-primary-muted)",
    borderColor: "var(--hoot-primary-border)",
    color: "var(--hoot-foreground)",
  },
};

const pinnedOffsetsSx = (offsets: Record<string, number>): SxProps<Theme> =>
  Object.fromEntries(
    Object.entries(offsets).map(([field, right]) => [`& .${PINNED}[data-field="${field}"]`, { right }]),
  );
