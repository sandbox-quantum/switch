import LinkOffOutlined from "@mui/icons-material/LinkOffOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { type InstalledApp, beginAppInstall } from "../../data/api";
import { useInstallablePlatforms, useInstalledApps } from "../../data/hooks";
import { EM_DASH, MONO_SX, formatDate, titleCase } from "../../theme/hootFormat";
import DisconnectAppDialog from "./DisconnectAppDialog";

/**
 * The other way a connection comes into being. Registering an app means
 * creating one on the platform, choosing its scopes and pasting its token in
 * here; installing means clicking a button and approving a consent screen,
 * with this deployment's own app supplying the credentials.
 *
 * Both are shown because both exist, and an operator has to be able to tell
 * which of their connections is which — a registered app's token is theirs to
 * rotate and an installed one's is not, and only the second has to be removed
 * through Disconnect.
 *
 * Renders nothing at all on a deployment that has no app of its own and has
 * never had one, which is most of them: an empty section explaining a feature
 * nobody here can use is worse than no section.
 */
type InstallRow = InstalledApp & { id: string };

const STATUS_COLOR: Record<string, "success" | "warning" | "default"> = {
  active: "success",
  // Ended at the platform rather than here — somebody removed the app, or its
  // token was killed. Warned rather than greyed out, because unlike
  // "disconnected" it is news.
  revoked: "warning",
  disconnected: "default",
};

interface Props {
  isAdmin: boolean;
  // Disconnecting removes the connection the install created, so the list of
  // connections above this section is stale once it succeeds.
  onConnectionsChanged: () => void;
}

export default function InstalledAppsSection({
  isAdmin,
  onConnectionsChanged,
}: Props) {
  const { data: platforms } = useInstallablePlatforms();
  const { data: installs, loading, refetch } = useInstalledApps();
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<InstalledApp | null>(
    null,
  );

  const handleInstall = useCallback(async (platform: string) => {
    setStarting(platform);
    setError(null);
    try {
      // A top-level navigation, not a popup and not an iframe: the platform's
      // consent screen sets cookies on its own domain and refuses to be
      // framed, and a popup opened after an await is what a browser blocks.
      // `starting` is deliberately left set — the page is on its way out.
      window.location.href = await beginAppInstall(platform);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the install");
      setStarting(null);
    }
  }, []);

  const handleDisconnected = useCallback(() => {
    setDisconnectTarget(null);
    refetch();
    onConnectionsChanged();
  }, [refetch, onConnectionsChanged]);

  const columns = useMemo<GridColDef<InstallRow>[]>(
    () => [
      {
        field: "platform",
        headerName: "Platform",
        width: 130,
        renderCell: ({ value }) => (
          <Chip label={titleCase(String(value))} size="small" />
        ),
      },
      {
        field: "external_workspace_id",
        headerName: "Workspace",
        width: 170,
        renderCell: ({ value }) => (
          <Box component="span" sx={MONO_SX}>
            {String(value)}
          </Box>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 140,
        renderCell: ({ value }) => (
          <Chip
            label={titleCase(String(value))}
            size="small"
            color={STATUS_COLOR[value as string] ?? "default"}
          />
        ),
      },
      {
        field: "scopes",
        headerName: "Scopes",
        flex: 1,
        minWidth: 180,
        // Verbatim, and in full on hover: a scope string that means nothing
        // here is still the answer to why the platform refused a call.
        renderCell: ({ value }) => (
          <Tooltip title={String(value)}>
            <Box component="span" sx={MONO_SX}>
              {String(value)}
            </Box>
          </Tooltip>
        ),
      },
      {
        field: "installed_at",
        headerName: "Installed",
        width: 130,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "ended_at",
        headerName: "Ended",
        width: 130,
        valueFormatter: (value) =>
          value ? formatDate(value as string) : EM_DASH,
      },
      ...(isAdmin
        ? [
            {
              field: "actions" as const,
              headerName: "",
              width: 70,
              sortable: false,
              filterable: false,
              align: "right" as const,
              renderCell: ({ row }: { row: InstallRow }) =>
                row.status === "active" ? (
                  <Tooltip title="Disconnect this app">
                    <IconButton
                      size="small"
                      onClick={() => setDisconnectTarget(row)}
                    >
                      <LinkOffOutlined fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null,
            },
          ]
        : []),
    ],
    [isAdmin],
  );

  const rows = useMemo<InstallRow[]>(() => installs ?? [], [installs]);

  const installable = platforms ?? [];
  if (installable.length === 0 && rows.length === 0) return null;

  return (
    <Box mt={5}>
      <Stack direction="row" alignItems="center" mb={1}>
        <Typography variant="h5">Installed apps</Typography>
        {isAdmin && (
          <Stack direction="row" spacing={1} sx={{ ml: "auto" }}>
            {installable.map((platform) => (
              <Button
                key={platform}
                variant="contained"
                disabled={starting !== null}
                startIcon={
                  starting === platform ? (
                    <CircularProgress size={16} />
                  ) : undefined
                }
                onClick={() => handleInstall(platform)}
              >
                Add to {titleCase(platform)}
              </Button>
            ))}
          </Stack>
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary" mb={2}>
        Installing adds this Switch deployment&apos;s own app to your workspace.
        Unlike a registered app, whose token is yours to rotate, an installed app
        authenticates with credentials this deployment holds and you cannot see
        or rotate. Removing it has to go through Disconnect rather than deleting
        its connection.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <CircularProgress />
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No workspaces yet. Use the button above to install the app into one.
        </Typography>
      ) : (
        <DataTable rows={rows} columns={columns} height={360} />
      )}

      <DisconnectAppDialog
        install={disconnectTarget}
        onClose={() => setDisconnectTarget(null)}
        onDisconnected={handleDisconnected}
      />
    </Box>
  );
}
