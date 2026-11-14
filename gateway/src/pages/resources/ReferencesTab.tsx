import { Box } from "@mui/material";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import DataTable, {
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import { type ReferenceDetail, loadReferences } from "../../data/api";
import { useLoad } from "../workspace/useLoad";
import {
  CategoryChip,
  ListBody,
  accessColumn,
  countColumn,
  createdColumn,
  descriptionColumn,
  nameColumn,
  ownerColumn,
  resourceSearchText,
  useRefetchOnRefresh,
} from "./resourceList";

interface Props {
  refreshKey: number;
}

const NOUN = { one: "reference", other: "references" };

const SELECT_FILTERS: SelectFilter[] = [
  { field: "owner_name", label: "Owner", allLabel: "All owners" },
  { field: "type", label: "Type", allLabel: "All types" },
];

const SEARCH = { label: "Search references", text: resourceSearchText };

/** What a reference's type reads as: its name, or the slug when no type of
 * that slug exists any more. */
export function referenceTypeLabel(ref: Pick<ReferenceDetail, "type" | "type_display_name">): string {
  return ref.type_display_name ?? `${ref.type} (unknown type)`;
}

export const referencePath = (ref: { id: string }) => `/resources/references/${ref.id}`;

export default function ReferencesTab({ refreshKey }: Props) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const { data, error, loading, refetch } = useLoad(loadReferences);
  useRefetchOnRefresh(refreshKey, refetch);
  const rows = useMemo(() => data ?? [], [data]);
  const workspace = session?.tenant?.name ?? "this workspace";

  const columns = useMemo<TableColumn<ReferenceDetail>[]>(() => {
    // Offered from the rows, so an unknown type is offered too, as it reads.
    const labels = new Map(rows.map((ref) => [ref.type, referenceTypeLabel(ref)]));
    const typeOptions = [...labels.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [
      nameColumn<ReferenceDetail>(referencePath),
      {
        field: "type",
        headerName: "Type",
        width: 160,
        valueGetter: (_value, row) => referenceTypeLabel(row),
        filter: { value: (row) => row.type, options: typeOptions },
        renderCell: ({ value }) => <CategoryChip label={value as string} />,
      },
      descriptionColumn(),
      accessColumn(rows),
      ownerColumn(rows),
      countColumn("attached_rooms_count", "Rooms", 90),
      createdColumn(),
    ];
  }, [rows]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ListBody what="references" loaded={data !== null} error={error} loading={loading} onRetry={refetch}>
        <DataTable
          rows={rows}
          columns={columns}
          fillHeight
          noun={NOUN}
          search={SEARCH}
          selectFilters={SELECT_FILTERS}
          initialSort={{ field: "created_at", sort: "desc" }}
          emptyState={
            <TableEmptyState title="No references yet">
              Yours and the public ones in {workspace} show here. Create one to point agents at a page or
              repository elsewhere.
            </TableEmptyState>
          }
          onRowClick={(params) => navigate(referencePath(params.row))}
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      </ListBody>
    </Box>
  );
}
