import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import type { CurrentOrganization, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { fetchCurrentOrganization } from "../../data/api";
import { useLoad } from "../workspace/useLoad";
import OrganizationAuditSection from "./OrganizationAuditSection";
import OrganizationConnectorsSection from "./OrganizationConnectorsSection";
import OrganizationServicesSection from "./OrganizationServicesSection";
import OrganizationIssuesNotice from "./OrganizationIssuesNotice";
import OrganizationMembersSection from "./OrganizationMembersSection";
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
  const { data: organization, error } = useOrganization();
  const connectorsEnabled = useOrganizationConnectorsEnabled();
  // A change to the members can make an issue or settle one; the notice is
  // read again, from scratch, after each.
  const [membersChanged, setMembersChanged] = useState(0);
  const onMembersChanged = useCallback(() => setMembersChanged((n) => n + 1), []);
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
  const { data: organization, error } = useOrganization();
  return (
    <Box>
      <OrganizationHeading organization={organization} isAdmin={organization?.administers === true} />
      {error && <Alert severity="error">{error}</Alert>}
      <Stack spacing={4}>
        {organization?.can_manage_members && <OrganizationIssuesNotice />}
      </Stack>
    </Box>
  );
}

export function OrganizationWorkspacesPage() {
  const { session } = useAuth();
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;
  return <WorkspacesSection currentId={tenant.id} canAdd={session.can_add_workspace} />;
}

export function OrganizationUsersPage() {
  const { session } = useAuth();
  const { data: organization, error } = useOrganization();
  // As on the organization page: a change to the members can make an issue
  // or settle one.
  const [membersChanged, setMembersChanged] = useState(0);
  const onMembersChanged = useCallback(() => setMembersChanged((n) => n + 1), []);
  const tenant = session?.tenant;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!session || !tenant?.organization_id || organization === null) return <CircularProgress />;
  return (
    <Stack spacing={4}>
      {organization.can_manage_members && <OrganizationIssuesNotice key={membersChanged} />}
      <MembersSection
        session={session}
        organizationId={tenant.organization_id}
        organization={organization}
        isAdmin={organization.administers}
        onChanged={onMembersChanged}
      />
    </Stack>
  );
}

export function OrganizationConnectorsPage() {
  return (
    <Stack spacing={4}>
      <OrganizationServicesSection />
      <OrganizationConnectorsSection />
    </Stack>
  );
}

export function OrganizationAuditLogPage() {
  return <OrganizationAuditSection />;
}
