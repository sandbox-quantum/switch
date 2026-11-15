import { Box } from "@mui/material";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import DataTable, {
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import { type PackageDetail, loadPackages } from "../../data/api";
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

const NOUN = { one: "package", other: "packages" };

const SELECT_FILTERS: SelectFilter[] = [{ field: "owner_name", label: "Owner", allLabel: "All owners" }];

const SEARCH = { label: "Search packages", text: resourceSearchText };

const packagePath = (pkg: { id: string }) => `/resources/packages/${pkg.id}`;

export default function PackagesTab({ refreshKey }: Props) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const { data, error, loading, refetch } = useLoad(loadPackages);
  useRefetchOnRefresh(refreshKey, refetch);
  const rows = useMemo(() => data ?? [], [data]);
  const workspace = session?.tenant?.name ?? "this workspace";

  const columns = useMemo<TableColumn<PackageDetail>[]>(
    () => [
      nameColumn<PackageDetail>(packagePath),
      descriptionColumn(),
      accessColumn(rows),
      ownerColumn(rows),
      countColumn("references_count", "References", 110),
      countColumn("documents_count", "Documents", 110),
      countColumn("attached_rooms_count", "Rooms", 90),
      createdColumn(),
    ],
    [rows],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ListBody what="packages" loaded={data !== null} error={error} loading={loading} onRetry={refetch}>
        <DataTable
          rows={rows}
          columns={columns}
          fillHeight
          noun={NOUN}
          search={SEARCH}
          selectFilters={SELECT_FILTERS}
          initialSort={{ field: "created_at", sort: "desc" }}
          emptyState={
            <TableEmptyState title="No packages yet">
              Yours and the public ones in {workspace} show here. Create one to bundle references and
              documents for a room.
            </TableEmptyState>
          }
          onRowClick={(params) => navigate(packagePath(params.row))}
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      </ListBody>
    </Box>
  );
}
