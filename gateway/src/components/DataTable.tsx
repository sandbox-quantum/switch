import {
  DataGridPro,
  type GridColDef,
  type GridRowId,
  type GridRowParams,
} from "@mui/x-data-grid-pro";
import { Box, type SxProps, type Theme } from "@mui/material";

interface DataTableProps<T extends { id: string | number }> {
  rows: T[];
  columns: GridColDef<T>[];
  height?: number;
  // When true, the table grows to fill its (flex-column) parent instead of
  // using a fixed `height`. The parent must be a flex column with a bounded
  // height (e.g. a page laid out with flexGrow + minHeight: 0).
  fillHeight?: boolean;
  pageSize?: number;
  checkboxSelection?: boolean;
  onRowSelectionModelChange?: (ids: GridRowId[]) => void;
  onRowClick?: (params: GridRowParams<T>) => void;
  sx?: SxProps<Theme>;
}

/** Hoot's grid treatment: a bordered 16px-radius surface with a cream header
 *  band, generous 52px rows, and tabular figures so numeric columns line up.
 *  Ported from the Hoot design system's DataTable. */
const HOOT_GRID_SX: SxProps<Theme> = {
  border: "1px solid var(--hoot-border)",
  borderRadius: "16px",
  "--DataGrid-rowBorderColor": "var(--hoot-border)",
  "& .MuiDataGrid-columnHeaders": {
    "--DataGrid-containerBackground": "var(--hoot-cream)",
  },
  "& .MuiDataGrid-columnHeader": {
    fontSize: "0.875rem",
    fontWeight: 500,
    letterSpacing: "-0.01em",
  },
  "& .MuiDataGrid-columnHeaderTitle": { fontWeight: 500, opacity: 0.7 },
  "& .MuiDataGrid-row": { minHeight: "52px !important" },
  "& .MuiDataGrid-row:hover": { backgroundColor: "rgb(0 0 0 / 0.03)" },
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

export default function DataTable<T extends { id: string | number }>({
  rows,
  columns,
  height = 600,
  fillHeight = false,
  pageSize = 25,
  checkboxSelection = false,
  onRowSelectionModelChange,
  onRowClick,
  sx,
}: DataTableProps<T>) {
  const extraSx = Array.isArray(sx) ? sx : sx ? [sx] : [];
  const grid = (
    <DataGridPro
      rows={rows}
      columns={columns}
      initialState={{
        pagination: { paginationModel: { pageSize } },
      }}
      pageSizeOptions={[10, 25, 50]}
      pagination
      checkboxSelection={checkboxSelection}
      onRowSelectionModelChange={
        onRowSelectionModelChange
          ? (model) => onRowSelectionModelChange([...model.ids])
          : undefined
      }
      onRowClick={onRowClick}
      disableRowSelectionOnClick
      sx={[HOOT_GRID_SX, { height: fillHeight ? "100%" : height }, ...extraSx]}
    />
  );

  if (!fillHeight) return grid;

  // Fill the remaining vertical space of a flex-column parent.
  return <Box sx={{ flex: 1, minHeight: 0, width: "100%" }}>{grid}</Box>;
}
