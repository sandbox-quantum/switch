import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DataTable from "../../components/DataTable";
import { type Erasure, type Person, fetchErasures, fetchPeople } from "../../data/api";
import { formatDate, titleCase } from "../../theme/hootFormat";
import EraseDialog from "./EraseDialog";
import { useLoad } from "./useLoad";

const POLL_MS = 3000;

export function describeErasure(erasure: Erasure): string {
  const messages = `${erasure.messages_deleted.toLocaleString()} ${erasure.messages_deleted === 1 ? "message" : "messages"}`;
  const files = `${erasure.files_deleted.toLocaleString()} ${erasure.files_deleted === 1 ? "file" : "files"}`;
  switch (erasure.state) {
    case "queued":
      return "Waiting to start";
    case "running":
      return `In progress: ${messages} deleted so far`;
    case "done":
      return `Erased: ${messages} and ${files} deleted`;
    case "failed":
      return `Failed after ${messages}: ${erasure.error ?? "unknown error"}`;
  }
}

const STATE_COLORS = {
  queued: "default",
  running: "info",
  done: "success",
  failed: "error",
} as const;

export default function PeopleSection({ tenantId }: { tenantId: string }) {
  const loadPeople = useCallback(() => fetchPeople(tenantId), [tenantId]);
  const loadErasures = useCallback(() => fetchErasures(tenantId), [tenantId]);
  const people = useLoad(loadPeople);
  const erasures = useLoad(loadErasures);
  const [search, setSearch] = useState("");
  const [erasing, setErasing] = useState<Person | null>(null);

  const active = (erasures.data ?? []).some(
    (e) => e.state === "queued" || e.state === "running",
  );
  const { refetch: refetchErasures } = erasures;
  const { refetch: refetchPeople } = people;
  // Only the requests are polled; the people list is re-read once, after the
  // last running request has finished, so the erased are gone from it.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refetchErasures(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refetchErasures]);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) void refetchPeople();
    wasActive.current = active;
  }, [active, refetchPeople]);

  const rows = useMemo<Person[]>(() => {
    const needle = search.trim().toLowerCase();
    return (people.data ?? [])
      .filter(
        (p) =>
          !needle ||
          p.username.toLowerCase().includes(needle) ||
          p.claimed_by.some((c) => c.name.toLowerCase().includes(needle)),
      );
  }, [people.data, search]);

  const columns = useMemo<GridColDef<Person>[]>(
    () => [
      { field: "username", headerName: "Name", flex: 1, minWidth: 160 },
      {
        field: "bridge_name",
        headerName: "Seen on",
        flex: 1,
        minWidth: 160,
        valueGetter: (_value, row) =>
          `${row.bridge_name ?? "Disconnected app"} (${titleCase(row.platform)})`,
      },
      { field: "message_count", headerName: "Messages", width: 110, type: "number" },
      {
        field: "claimed_by",
        headerName: "Claimed by",
        flex: 1,
        minWidth: 160,
        sortable: false,
        valueGetter: (_value, row) => row.claimed_by.map((c) => c.name).join(", "),
      },
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        renderCell: ({ row }) => (
          <Button size="small" color="error" onClick={() => setErasing(row)}>
            Erase
          </Button>
        ),
      },
    ],
    [],
  );

  const queued = async () => {
    await refetchErasures();
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">People</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Everyone seen in this workspace&apos;s rooms through a chat app, including apps since
        disconnected. Erasing
        someone permanently deletes every message they sent and their files, for example to
        answer a GDPR erasure request. Only owners can see this list.
      </Typography>
      {people.error && <Alert severity="error">{people.error}</Alert>}
      {erasures.error && <Alert severity="error">{erasures.error}</Alert>}
      {(erasures.data ?? []).slice(0, 5).map((erasure) => (
        <Stack key={erasure.id} direction="row" spacing={1} alignItems="center">
          <Chip
            size="small"
            label={titleCase(erasure.state)}
            color={STATE_COLORS[erasure.state]}
          />
          <Typography variant="body2">
            {describeErasure(erasure)} · requested {formatDate(erasure.created_at)}
          </Typography>
        </Stack>
      ))}
      <TextField
        size="small"
        label="Search people"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        sx={{ maxWidth: 320 }}
      />
      {people.loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          height={Math.min(520, 108 + Math.max(1, rows.length) * 52)}
          pageSize={25}
        />
      )}
      <EraseDialog
        tenantId={tenantId}
        person={erasing}
        people={people.data ?? []}
        onClose={() => setErasing(null)}
        onQueued={() => void queued()}
      />
    </Stack>
  );
}
