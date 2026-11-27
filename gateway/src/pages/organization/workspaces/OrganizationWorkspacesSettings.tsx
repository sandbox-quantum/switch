import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import InfoTip from "../../../components/InfoTip";
import PageHeader from "../../../components/PageHeader";
import SuccessSnackbar from "../../../components/SuccessSnackbar";
import { useAuth } from "../../../data/AuthContext";
import { fetchCurrentOrganization, fetchOrganizationWorkspaces } from "../../../data/api";
import { useLoad } from "../../workspace/useLoad";
import WorkspacesTable from "./WorkspacesTable";

/** Organization settings › Workspaces: every workspace in
 * the organization, who administers each, and for an organization admin,
 * what can be done with one. The platform operator may open it too, read
 * only: running the organization's workspaces is its admins'. */
export default function OrganizationWorkspacesSettings() {
  const { session, recheck } = useAuth();
  const loadOrganization = useCallback(() => fetchCurrentOrganization(), []);
  const organization = useLoad(loadOrganization);
  const loadWorkspaces = useCallback(() => fetchOrganizationWorkspaces(), []);
  const workspaces = useLoad(loadWorkspaces);
  const [notice, setNotice] = useState<string | null>(null);

  // The session too: the switcher lists the workspaces by name.
  const refetchWorkspaces = workspaces.refetch;
  const onChanged = useCallback(async () => {
    await Promise.all([refetchWorkspaces(), recheck()]);
  }, [refetchWorkspaces, recheck]);

  const error = organization.error ?? workspaces.error;
  const loading = organization.data === null || workspaces.data === null;

  if (!session) return <CircularProgress />;

  return (
    <Box>
      <PageHeader
        sx={{ mb: 3 }}
        title={<Typography variant="h5">Workspaces</Typography>}
        description={
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              The workspaces in {organization.data?.name ?? "this organization"}.
            </Typography>
            <InfoTip>
              Org admins administer every workspace, so they aren't listed under Admins, and each
              workspace's users include them.
            </InfoTip>
          </Stack>
        }
      />
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
      <SuccessSnackbar message={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}
