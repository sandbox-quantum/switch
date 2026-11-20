import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { ORGANIZATION_NAME_MAX, fetchCurrentOrganization, renameOrganization } from "../../data/api";
import { announceOrganizationRenamed } from "../../data/organizationEvents";
import EditableField from "../../components/EditableField";
import SuccessSnackbar from "../../components/SuccessSnackbar";
import { useLoad } from "../workspace/useLoad";
import OrganizationAuditSection from "./OrganizationAuditSection";
import OrganizationConnectorsSettings from "./connectors/OrganizationConnectorsSettings";
import OrganizationIssuesNotice from "./OrganizationIssuesNotice";
import OrganizationDevicesSettings from "./devices/OrganizationDevicesSettings";
import OrganizationGuardrails from "./guardrails/OrganizationGuardrails";
import OrganizationUsersSettings from "./users/OrganizationUsersSettings";
import OrganizationWorkspacesSettings from "./workspaces/OrganizationWorkspacesSettings";

function useOrganization() {
  const load = useCallback(() => fetchCurrentOrganization(), []);
  return useLoad(load);
}

// Organization settings. The route table admits the organization's admins,
// and the operator to General, Workspaces and Users.

export function OrganizationGeneralPage() {
  const { data: organization, error, refetch } = useOrganization();
  const [notice, setNotice] = useState<string | null>(null);

  const rename = async (draft: string) => {
    const { name } = await renameOrganization(draft);
    announceOrganizationRenamed();
    await refetch();
    setNotice(`Organization renamed to ${name}.`);
  };

  return (
    <Box>
      <Stack spacing={0.5} sx={{ mb: 3 }}>
        <Typography variant="h5">General</Typography>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {organization === null ? (
        !error && <CircularProgress />
      ) : (
        <Stack spacing={4}>
          {organization.can_manage_members && <OrganizationIssuesNotice />}
          <EditableField
            label="Organization name"
            value={organization.name}
            canEdit={organization.administers}
            readOnlyHelper="Only an org admin can change this."
            editLabel="Rename organization"
            maxLength={ORGANIZATION_NAME_MAX}
            width={420}
            onSave={rename}
          />
        </Stack>
      )}
      <SuccessSnackbar message={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}

export function OrganizationWorkspacesPage() {
  return <OrganizationWorkspacesSettings />;
}

export function OrganizationUsersPage() {
  const { data: organization, error, refetch: refetchOrganization } = useOrganization();
  // A change to the members can make an issue or settle one, and change what
  // the server says the viewer may do (the operator who makes an admin can
  // manage the members no more): both are read again after each.
  const [membersChanged, setMembersChanged] = useState(0);
  const onMembersChanged = useCallback(() => {
    setMembersChanged((n) => n + 1);
    void refetchOrganization();
  }, [refetchOrganization]);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (organization === null) return <CircularProgress />;
  return (
    <Stack spacing={4}>
      {organization.can_manage_members && <OrganizationIssuesNotice key={membersChanged} />}
      <OrganizationUsersSettings organization={organization} onChanged={onMembersChanged} />
    </Stack>
  );
}

export function OrganizationGuardrailsPage() {
  const { data: organization, error } = useOrganization();
  if (error) return <Alert severity="error">{error}</Alert>;
  if (organization === null) return <CircularProgress />;
  return <OrganizationGuardrails organizationName={organization.name} />;
}

export function OrganizationDevicesPage() {
  const { data: organization, error } = useOrganization();
  if (error) return <Alert severity="error">{error}</Alert>;
  if (organization === null) return <CircularProgress />;
  return <OrganizationDevicesSettings organizationName={organization.name} />;
}

export function OrganizationConnectorsPage() {
  return <OrganizationConnectorsSettings />;
}

export function OrganizationAuditLogPage() {
  const { data: organization, error } = useOrganization();
  if (error) return <Alert severity="error">{error}</Alert>;
  if (organization === null) return <CircularProgress />;
  return (
    <OrganizationAuditSection
      organizationName={organization.name}
      membersFromDirectory={organization.members_from_directory}
    />
  );
}
