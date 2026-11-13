import { Alert, Box, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import type { CurrentOrganization, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { ORGANIZATION_NAME_MAX, fetchCurrentOrganization, renameOrganization } from "../../data/api";
import { announceOrganizationRenamed } from "../../data/organizationEvents";
import EditableField from "../../components/EditableField";
import { useLoad } from "../workspace/useLoad";
import OrganizationAuditSection from "./OrganizationAuditSection";
import OrganizationConnectorsSettings from "./connectors/OrganizationConnectorsSettings";
import OrganizationConnectorsSection from "./OrganizationConnectorsSection";
import OrganizationServicesSection from "./OrganizationServicesSection";
import OrganizationIssuesNotice from "./OrganizationIssuesNotice";
import OrganizationMembersSection from "./OrganizationMembersSection";
import OrganizationDevicesSettings from "./devices/OrganizationDevicesSettings";
import OrganizationGuardrails from "./guardrails/OrganizationGuardrails";
import OrganizationUsersSettings from "./users/OrganizationUsersSettings";
import OrganizationWorkspacesSettings from "./workspaces/OrganizationWorkspacesSettings";
import WorkspacesSection from "./WorkspacesSection";

function useOrganization() {
  const load = useCallback(() => fetchCurrentOrganization(), []);
  return useLoad(load);
}

function OrganizationHeading({
  organization,
  isAdmin,
}: {
  organization: CurrentOrganization | null;
  isAdmin: boolean;
}) {
  return (
    <Stack spacing={0.5} mb={3}>
      <Typography variant="h5">{organization?.name ?? ""}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {isAdmin
          ? "You are an admin of this organization, and so of every workspace in it."
          : organization === null
            ? ""
            : organization.role === "member"
              ? "You are a member of this organization."
              : "You are here as platform operator, not as a member of this organization."}
      </Typography>
    </Stack>
  );
}

function MembersSection({
  session,
  organizationId,
  organization,
  isAdmin,
  onChanged,
}: {
  session: Session;
  organizationId: string;
  organization: CurrentOrganization | null;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  return (
    <OrganizationMembersSection
      selfId={session.user.id}
      organizationId={organizationId}
      asOperator={!isAdmin}
      canManage={organization?.can_manage_members === true}
      fromDirectory={organization?.members_from_directory === true}
      directoryTakesChanges={organization?.directory_takes_changes === true}
      onChanged={onChanged}
    />
  );
}

/** Where the server runs organization connector apps, which mounts the
 * routes both sections read. */
function useOrganizationConnectorsEnabled(): boolean {
  const { capabilities } = useAuth();
  return (
    capabilities.features.service_connections && capabilities.features.organization_connector_apps
  );
}

/** The organization the current workspace belongs to. Its workspaces are
 * listed to anyone in it; its members and audit log to its admins, the only
 * ones the server answers. */
export default function OrganizationPage() {
  const { session, capabilities } = useAuth();
  const { data: organization, error, refetch: refetchOrganization } = useOrganization();
  const connectorsEnabled = useOrganizationConnectorsEnabled();
  // A change to the members can make an issue or settle one, and change what
  // the server says the viewer may do (the operator who makes an admin can
  // manage the members no more): both are read again after each.
  const [membersChanged, setMembersChanged] = useState(0);
  const onMembersChanged = useCallback(() => {
    setMembersChanged((n) => n + 1);
    void refetchOrganization();
  }, [refetchOrganization]);
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;
  if (tenant.organization_id === null) {
    return <Alert severity="info">This workspace belongs to no organization.</Alert>;
  }
  const isAdmin = organization?.administers === true;

  return (
    <Box>
      <OrganizationHeading organization={organization} isAdmin={isAdmin} />
      {error && <Alert severity="error">{error}</Alert>}
      <Stack spacing={4}>
        {organization?.can_manage_members && <OrganizationIssuesNotice key={membersChanged} />}
        <WorkspacesSection currentId={tenant.id} canAdd={session.can_add_workspace} />
        {organization !== null && (isAdmin || capabilities.isOperator) && (
          <MembersSection
            session={session}
            organizationId={tenant.organization_id}
            organization={organization}
            isAdmin={isAdmin}
            onChanged={onMembersChanged}
          />
        )}
        {isAdmin && organization !== null && (
          <OrganizationGuardrails organizationName={organization.name} heading="section" />
        )}
        {isAdmin && connectorsEnabled && <OrganizationServicesSection />}
        {isAdmin && connectorsEnabled && <OrganizationConnectorsSection />}
        {isAdmin && <OrganizationAuditSection />}
      </Stack>
    </Box>
  );
}

// The new layout's Organization settings. The route table admits the
// organization's admins, and the operator to General, Workspaces and Users.

export function OrganizationGeneralPage() {
  const { data: organization, error, refetch } = useOrganization();
  // Kept after the message closes, so it still names the organization while
  // it fades out.
  const [renamedTo, setRenamedTo] = useState("");
  const [noticeOpen, setNoticeOpen] = useState(false);

  const rename = async (draft: string) => {
    const { name } = await renameOrganization(draft);
    announceOrganizationRenamed();
    await refetch();
    setRenamedTo(name);
    setNoticeOpen(true);
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
      <Snackbar
        open={noticeOpen}
        autoHideDuration={5000}
        onClose={() => setNoticeOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Alert severity="success" onClose={() => setNoticeOpen(false)}>
          Organization renamed to {renamedTo}.
        </Alert>
      </Snackbar>
    </Box>
  );
}

export function OrganizationWorkspacesPage() {
  return <OrganizationWorkspacesSettings />;
}

export function OrganizationUsersPage() {
  const { data: organization, error, refetch: refetchOrganization } = useOrganization();
  // As on the organization page: after a change to the members, the issues
  // and the organization's own answers are read again.
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
  return <OrganizationGuardrails organizationName={organization.name} heading="page" />;
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
  return <OrganizationAuditSection />;
}
