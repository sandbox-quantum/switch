import { Box } from "@mui/material";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import DataTable, {
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import { type DocumentSummary, loadDocuments } from "../../data/api";
import { useLoad } from "../workspace/useLoad";
import {
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

const NOUN = { one: "document", other: "documents" };

const SELECT_FILTERS: SelectFilter[] = [{ field: "owner_name", label: "Owner", allLabel: "All owners" }];

const SEARCH = { label: "Search documents", text: resourceSearchText };

const documentPath = (doc: { id: string }) => `/resources/documents/${doc.id}`;

export default function DocumentsTab({ refreshKey }: Props) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const { data, error, loading, refetch } = useLoad(loadDocuments);
  useRefetchOnRefresh(refreshKey, refetch);
  const rows = useMemo(() => data ?? [], [data]);
  const workspace = session?.tenant?.name ?? "this workspace";

  const columns = useMemo<TableColumn<DocumentSummary>[]>(
    () => [
      nameColumn<DocumentSummary>(documentPath),
      descriptionColumn(),
      accessColumn(rows),
      ownerColumn(rows),
      countColumn("attached_rooms_count", "Rooms", 90),
      createdColumn(),
    ],
    [rows],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ListBody what="documents" loaded={data !== null} error={error} loading={loading} onRetry={refetch}>
        <DataTable
          rows={rows}
          columns={columns}
          fillHeight
          noun={NOUN}
          search={SEARCH}
          selectFilters={SELECT_FILTERS}
          initialSort={{ field: "created_at", sort: "desc" }}
          emptyState={
            <TableEmptyState title="No documents yet">
              Yours and the public ones in {workspace} show here. Create one to give agents text to read
              in rooms.
            </TableEmptyState>
          }
          onRowClick={(params) => navigate(documentPath(params.row))}
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      </ListBody>
    </Box>
  );
}
