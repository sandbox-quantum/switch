import CloseOutlined from "@mui/icons-material/CloseOutlined";
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
  Link,
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
import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useState } from "react";
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
   *  agents" while filtered). Without it there is no count. A table with a
   *  count, a search, quick filters or a column `filter` filters its own
   *  rows, so the grid's own filtering is off and the count stays true. */
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
   *  filters. Word it for the viewer from their capabilities, not their
   *  role: "No agents in this workspace yet" for someone who administers
   *  the workspace, "You don't own any agents" for anyone else. */
  emptyState?: ReactNode;
}

/** A hovered or selected row takes the muted fill. A grey chip shares that
 *  fill but keeps its hairline, so it still reads as a chip. Opaque, so a
 *  pinned cell can take it too. */
const ROW_HOVER = "var(--sw-accent)";
const ROW_SELECTED = "var(--sw-muted)";

/** The grid treatment: a bordered 16px-radius surface with a cream header
 *  band, generous 52px rows, and tabular figures so numeric columns line up.
 *  Ported from the design prototype's DataTable. */
const GRID_SX: SxProps<Theme> = {
  border: "1px solid var(--sw-border)",
  // The header and footer band: the cream wash, half as strong in dark
  // mode, where the full wash lifts the band a step above the table.
  "--table-band": "var(--sw-cream)",
  '[data-mui-color-scheme="dark"] &': { "--table-band": "color-mix(in oklch, var(--sw-cream) 50%, transparent)" },
  borderRadius: "16px",
  "--DataGrid-rowBorderColor": "var(--sw-border)",
  // The band is painted on the header row and the cells let it through: the
  // grid paints each header cell with its own opaque background otherwise.
  // Cream is a wash, so it is laid over the card fill: the header stays put
  // while the rows scroll under it, and must hide them.
  "& .MuiDataGrid-columnHeaders": {
    backgroundColor: "var(--sw-card)",
    backgroundImage: "linear-gradient(var(--table-band), var(--table-band))",
  },
  "& .MuiDataGrid-columnHeader, & .MuiDataGrid-columnHeaders .MuiDataGrid-filler": {
    backgroundColor: "transparent",
  },
  "& .MuiDataGrid-columnHeader": {
    fontSize: "0.875rem",
    fontWeight: 500,
    letterSpacing: "-0.01em",
  },
  "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 500, opacity: 0.7 },
  // The sort and menu buttons paint the grid's own header fill, which shows
  // as a solid square on the cream band.
  "& .MuiDataGrid-sortButton:not(:hover), & .MuiDataGrid-menuIconButton:not(:hover)": {
    backgroundColor: "transparent",
  },
  "& .MuiDataGrid-row": { minHeight: "52px !important" },
  "& .MuiDataGrid-row:hover": { backgroundColor: ROW_HOVER },
  "& .MuiDataGrid-row.Mui-selected": {
    backgroundColor: ROW_SELECTED,
    "&:hover": { backgroundColor: ROW_SELECTED },
  },
  "& .MuiDataGrid-cell": {
    minHeight: 52,
    fontSize: "0.9375rem",
    fontVariantNumeric: "tabular-nums",
    borderTopColor: "var(--sw-border)",
  },
  "& .MuiDataGrid-footerContainer": {
    backgroundColor: "var(--table-band)",
    // The hairline is drawn inside the footer, so it stays the 52px pages
    // count rather than 52px plus a border.
    borderTop: "none",
    boxShadow: "inset 0 1px 0 var(--sw-border)",
    borderBottomLeftRadius: "16px",
    borderBottomRightRadius: "16px",
  },
  "& .MuiDataGrid-columnSeparator": { display: "none" },
  "& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within, & .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within":
    { outline: "2px solid var(--sw-ring)", outlineOffset: "-2px" },
  "& .MuiDataGrid-overlay": {
    fontSize: "0.875rem",
    color: "var(--sw-muted-foreground)",
    backgroundColor: "transparent",
  },
};

const FILTERABLE = "table-filterable";

/** A table that filters its own rows keeps a filterable column's menu button
 *  in view, faintly, since that menu is where the column is filtered. Other
 *  columns show theirs on hover, as the grid does. */
const OWN_FILTERING_SX: SxProps<Theme> = {
  [`& .${FILTERABLE} .MuiDataGrid-menuIcon`]: { visibility: "visible", width: "auto", opacity: 0.5 },
  [`& .${FILTERABLE}:hover .MuiDataGrid-menuIcon`]: { opacity: 1 },
};

const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 52;

/** The least a table with no rows to show is given: its header and two rows
 *  for what it says instead. Pages size a table to its rows (`108 + rows *
 *  52`), which leaves no room at all for "No rows" when there are none. An
 *  empty table has no footer: there is nothing to page through. */
const EMPTY_TABLE_HEIGHT = HEADER_HEIGHT + 2 * ROW_HEIGHT;

const PINNED = "table-pinned-right";

/** The default for `pinnedRight`, kept stable: a fresh `[]` on every render
 *  would rebuild the grid's columns, and the grid would rebuild its whole
 *  column model, on each keystroke in the search box. */
const NOT_PINNED: string[] = [];

/** The free grid has no column pinning, so a pinned column is a sticky one:
 *  the scrolling columns pass under it, which needs an opaque fill that
 *  follows the row's hover and selection, and a hairline on its left edge.
 *  The header's cream is a wash, so it is laid over the card fill to match
 *  the unpinned header cells. */
const PINNED_SX: SxProps<Theme> = {
  [`& .${PINNED}`]: {
    position: "sticky",
    zIndex: 1,
    backgroundColor: "var(--sw-card)",
    boxShadow: "inset 1px 0 0 var(--sw-border)",
  },
  [`& .MuiDataGrid-columnHeader.${PINNED}`]: {
    background: "linear-gradient(var(--table-band), var(--table-band)), var(--sw-card)",
  },
  [`& .MuiDataGrid-row:hover .${PINNED}`]: { backgroundColor: ROW_HOVER },
  [`& .MuiDataGrid-row.Mui-selected .${PINNED}`]: { backgroundColor: ROW_SELECTED },
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
): { columns: GridColDef<T>[]; offsets: Record<string, number>; pinnedWidth: number } {
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
    const base = (
      ownFiltering
        ? {
            ...column,
            filterable: Boolean(filter),
            ...(filter && { headerClassName: appendClass(column.headerClassName, FILTERABLE) }),
          }
        : column
    ) as GridColDef<T>;
    if (!(column.field in offsets)) return base;
    return {
      ...base,
      resizable: false,
      hideable: false,
      headerClassName: appendClass(base.headerClassName, PINNED),
      cellClassName: appendClass(column.cellClassName, PINNED),
    } as GridColDef<T>;
  };

  return {
    columns: [...columns.filter((column) => !(column.field in offsets)), ...pinned].map(toGrid),
    offsets,
    pinnedWidth: right,
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

/** The table's own message in place of rows. It sits inside the grid, which
 *  may hold only rows, so it is one row and one cell: the "Clear filters"
 *  button or a page's "Add agent" inside it stays valid markup. */
function TableOverlay({ tableEmpty }: GridOverlayProps & { tableEmpty?: ReactNode }) {
  return (
    <Box role="row" sx={{ height: "100%" }}>
      <Stack
        role="gridcell"
        sx={{ height: "100%", alignItems: "center", justifyContent: "center", p: 2, textAlign: "center" }}
      >
        {tableEmpty}
      </Stack>
    </Box>
  );
}

/** A table's message for when it has no rows: what is missing, in a line,
 *  and what to do about it, if anything. Pages word both for the viewer,
 *  from their capabilities. */
export function TableEmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Stack spacing={0.5} sx={{ alignItems: "center", maxWidth: 440 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary" }}>
        {title}
      </Typography>
      {children && (
        <Typography variant="body2" color="text.secondary">
          {children}
        </Typography>
      )}
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
  pinnedRight = NOT_PINNED,
  emptyState,
}: DataTableProps<T>) {
  const apiRef = useGridApiRef();
  const [selection, setSelectionState] = useState<FilterSelection>({});
  const [query, setQueryState] = useState("");
  const filterHeadingId = useId();

  // Narrowing the rows starts the table again from its first page. The grid
  // does that for its own filters, but these never reach it: it only sees
  // fewer rows, and moves only once its page no longer exists.
  const setSelection = (update: FilterSelection | ((current: FilterSelection) => FilterSelection)) => {
    setSelectionState(update);
    apiRef.current?.setPage(0);
  };
  const setQuery = (next: string) => {
    setQueryState(next);
    apiRef.current?.setPage(0);
  };
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
    const header = column.headerName ?? column.field;
    return picked.map((value) => {
      const label = labels.get(value) ?? value;
      const remove = () => setSelection((current) => toggleValue(current, column.field, value));
      // The whole chip is the button that removes it, so Enter and Space work
      // as well as Backspace, and it is named for what pressing it does.
      return (
        <Chip
          key={`${column.field}:${value}`}
          aria-label={`Remove ${header}: ${label} filter`}
          label={
            <>
              {header}: <Box component="strong">{label}</Box>
            </>
          }
          onClick={remove}
          onDelete={remove}
          deleteIcon={<CloseOutlined aria-hidden />}
          sx={FILTER_CHIP_SX}
        />
      );
    });
  });

  // Every row on one page and in view: no footer, since there is nothing to
  // page through, and no taller than its rows, so a short or narrowed table
  // leaves no blank card under it. Rows that fit the page size but not the
  // height keep the footer and its count, so none sit unseen below the fold.
  // A table filling its parent can't know its height here, so it keeps its
  // footer whenever it has rows.
  const rowsHeight = HEADER_HEIGHT + ROW_HEIGHT * shown.length;
  const fitsOnePage =
    shown.length === 0 || (!fillHeight && shown.length <= pageSize && rowsHeight <= height);

  // Tables that leave filtering to the grid keep its own overlays.
  const tableOverlay = emptyState !== undefined || (ownFiltering && rows.length > 0);
  const pickerColumn = picker ? filterable.find((column) => column.field === picker.field) : undefined;
  const pinnedSx = pinnedRight.length > 0 ? [PINNED_SX, pinnedOffsetsSx(grid.offsets)] : [];
  const extraSx = Array.isArray(sx) ? sx : sx ? [sx] : [];

  // The grid scrolls a focused cell to the edge of its viewport, which a
  // pinned column covers, so a cell reached by keyboard would sit under it.
  // Scroll it the rest of the way out from under the pinned columns.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || grid.pinnedWidth === 0) return;
    return api.subscribeEvent("cellFocusIn", ({ id, field }) => {
      if (field in grid.offsets) return;
      requestAnimationFrame(() => {
        const cell = api.getCellElement(id, field);
        const scroller = cell?.closest(".MuiDataGrid-virtualScroller");
        if (!cell || !scroller) return;
        const visibleRight = scroller.getBoundingClientRect().left + scroller.clientWidth - grid.pinnedWidth;
        const hidden = cell.getBoundingClientRect().right - visibleRight;
        if (hidden > 0) scroller.scrollLeft += hidden;
      });
    });
  }, [apiRef, grid]);

  const table = (
    <DataGrid
      apiRef={apiRef}
      rows={shown}
      columns={grid.columns}
      initialState={{
        pagination: { paginationModel: { pageSize } },
      }}
      pageSizeOptions={[...new Set([pageSize, 25, 50, 100])].sort((a, b) => a - b)}
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
      // A sticky column only sticks while it is rendered, and the grid drops
      // a column once it scrolls out of view, so with one pinned every cell
      // renders. A page holds at most 100 rows, so that stays cheap.
      disableVirtualization={pinnedRight.length > 0}
      disableColumnFilter={ownFiltering}
      hideFooter={fitsOnePage}
      slots={tableOverlay ? { noRowsOverlay: TableOverlay } : undefined}
      slotProps={{
        ...(tableOverlay && { noRowsOverlay: { tableEmpty: empty } }),
        ...(ownFiltering && { columnMenu: TABLE_COLUMN_MENU }),
        // A pinned column is the row's actions, not a column to hide.
        columnsManagement: {
          getTogglableColumns: (all: GridColDef[]) =>
            all.filter((column) => !(column.field in grid.offsets)).map((column) => column.field),
        },
      }}
      sx={[
        GRID_SX,
        ...(ownFiltering ? [OWN_FILTERING_SX] : []),
        ...pinnedSx,
        fillHeight
          ? { height: "100%" }
          : {
              // A fixed `height` is the table's content: header, rows and
              // footer, as pages size a table to its rows. The border goes
              // outside it, or each such table would be 2px short and scroll.
              boxSizing: "content-box",
              height:
                shown.length === 0
                  ? Math.max(height, EMPTY_TABLE_HEIGHT)
                  : fitsOnePage
                    ? rowsHeight
                    : height,
            },
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
            {quickFilters.length > 0 && (
              <Stack direction="row" spacing={1} role="group" aria-label="Quick filters">
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
              </Stack>
            )}
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
            <Link
              component="button"
              underline="always"
              onClick={() => setSelection({})}
              sx={{ fontSize: "0.875rem", color: "var(--sw-muted-foreground)" }}
            >
              Clear filters
            </Link>
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
          slotProps={{
            paper: {
              role: "dialog",
              "aria-labelledby": filterHeadingId,
              sx: { p: 1.5, minWidth: 220, maxWidth: 320, maxHeight: 360 },
            },
          }}
        >
          <Typography id={filterHeadingId} variant="overline" color="text.secondary" component="p" sx={{ px: 1 }}>
            Filter by {pickerColumn.headerName ?? pickerColumn.field}
          </Typography>
          <Stack>
            {filterOptions(pickerColumn, rows).map((option) => (
              <FormControlLabel
                key={option.value}
                sx={{ mx: 0, px: 1, borderRadius: 1.5, "&:hover": { backgroundColor: "var(--sw-accent)" } }}
                control={
                  <Checkbox
                    size="small"
                    checked={(selection[pickerColumn.field] ?? []).includes(option.value)}
                    onChange={() =>
                      setSelection((current) => toggleValue(current, pickerColumn.field, option.value))
                    }
                  />
                }
                label={
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    {option.label}
                  </Typography>
                }
              />
            ))}
          </Stack>
        </Popover>
      )}
    </TableFilterContext.Provider>
  );
}

/** A picked filter, as the design system's filter chip: the column in the label's weight,
 *  the value bold, on the muted fill with a small cross. */
const FILTER_CHIP_SX: SxProps<Theme> = {
  height: 34,
  borderRadius: "12px",
  backgroundColor: "var(--sw-muted)",
  color: "var(--sw-foreground)",
  fontSize: "0.875rem",
  fontWeight: 500,
  "& .MuiChip-label": { pl: 1.5, pr: 1 },
  "& strong": { fontWeight: 700 },
  "& .MuiChip-deleteIcon": { fontSize: 16, color: "var(--sw-muted-foreground)", mr: 1, ml: -0.5 },
  "&:hover, &:focus-visible": { backgroundColor: "var(--sw-accent)" },
};

/** Quick filters share a text field's 36px height and hairline so the toolbar
 *  reads as one strip; pressed is a quiet wash, not a status colour. */
const QUICK_FILTER_SX: SxProps<Theme> = {
  height: 36,
  px: 1.5,
  borderRadius: "8px",
  borderColor: "var(--sw-field-border)",
  color: "var(--sw-foreground)",
  fontSize: "0.875rem",
  fontWeight: 500,
  textTransform: "none",
  "&.Mui-selected, &.Mui-selected:hover": {
    backgroundColor: "var(--sw-primary-muted)",
    borderColor: "var(--sw-primary-border)",
    color: "var(--sw-foreground)",
  },
};

const pinnedOffsetsSx = (offsets: Record<string, number>): SxProps<Theme> =>
  Object.fromEntries(
    Object.entries(offsets).map(([field, right]) => [`& .${PINNED}[data-field="${field}"]`, { right }]),
  );
