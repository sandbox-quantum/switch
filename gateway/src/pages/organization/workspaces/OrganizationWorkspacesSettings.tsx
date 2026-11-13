import Add from "@mui/icons-material/Add";
import { Alert, Box, Button, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import InfoTip from "../../../components/InfoTip";
import { useAuth } from "../../../data/AuthContext";
import { fetchCurrentOrganization, fetchOrganizationWorkspaces } from "../../../data/api";
import { useLoad } from "../../workspace/useLoad";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import WorkspacesTable from "./WorkspacesTable";

/** Organization settings › Workspaces, in the new layout: every workspace in
 * the organization, who administers each, and for an organization admin,
 * what can be done with one. The platform operator may open it too, read
 * only: running the organization's workspaces is its admins'. */
export default function OrganizationWorkspacesSettings() {
  const { session, recheck } = useAuth();
  const loadOrganization = useCallback(() => fetchCurrentOrganization(), []);
  const organization = useLoad(loadOrganization);
  const loadWorkspaces = useCallback(() => fetchOrganizationWorkspaces(), []);
  const workspaces = useLoad(loadWorkspaces);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The session too: the switcher lists the workspaces by name, and whether
  // another may be created follows the allowance a new one uses up.
  const refetchWorkspaces = workspaces.refetch;
  const onChanged = useCallback(async () => {
    await Promise.all([refetchWorkspaces(), recheck()]);
  }, [refetchWorkspaces, recheck]);

  const error = organization.error ?? workspaces.error;
  const loading = organization.data === null || workspaces.data === null;

  if (!session) return <CircularProgress />;

  return (
    <Box>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}
      >
        <Stack spacing={0.5}>
          <Typography variant="h5">Workspaces</Typography>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Typography variant="body2" color="text.secondary">
              The workspaces in {organization.data?.name ?? ""}.
            </Typography>
            <InfoTip>
              Org admins administer every workspace, so they aren't listed under Admins.
            </InfoTip>
          </Stack>
        </Stack>
        {session.can_add_workspace && (
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={() => setCreateOpen(true)}
            sx={{ flexShrink: 0 }}
          >
            Create workspace
          </Button>
        )}
      </Stack>
      {error !== null ? (
        <Alert severity="error">{error}</Alert>
      ) : loading ? (
        <CircularProgress />
      ) : (
        <WorkspacesTable
          administers={organization.data!.administers}
          organizationName={organization.data!.name}
          currentId={session.tenant?.id ?? null}
          workspaces={workspaces.data!}
          onChanged={onChanged}
          onNotice={setNotice}
        />
      )}
      {organization.data && (
        <CreateWorkspaceDialog
          open={createOpen}
          organizationName={organization.data.name}
          existingNames={(workspaces.data ?? []).map((workspace) => workspace.name)}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false);
            setNotice(`Created ${name}.`);
            void onChanged();
          }}
        />
      )}
      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </Box>
  );
}
