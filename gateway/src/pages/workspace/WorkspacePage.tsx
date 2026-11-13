import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import type { Session, TenantMembership } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import DeleteWorkspaceSection from "./DeleteWorkspaceSection";
import InvitationsSection from "./InvitationsSection";
import MembersSection from "./MembersSection";
import PeopleSection from "./PeopleSection";
import PrivateChannelRoomsSection from "./PrivateChannelRoomsSection";
import RetentionSection from "./RetentionSection";

function WorkspaceHeading({ tenant }: { tenant: TenantMembership }) {
  return (
    <Stack spacing={0.5} mb={3}>
      <Typography variant="h5">{tenant.name}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        You are {tenant.role === "admin" ? "an admin" : `a ${tenant.role}`} of this workspace.
      </Typography>
    </Stack>
  );
}

function UsersSections({
  session,
  tenant,
  canAdmin,
}: {
  session: Session;
  tenant: TenantMembership;
  canAdmin: boolean;
}) {
  return (
    <>
      <MembersSection tenantId={tenant.id} selfId={session.user.id} />
      {canAdmin ? (
        <InvitationsSection
          tenantId={tenant.id}
          inOrganization={tenant.organization_id !== null}
          emailEnabled={session.invite_email_enabled}
        />
      ) : (
        <Alert severity="info">Ask a workspace admin to invite someone.</Alert>
      )}
    </>
  );
}

/** Retention, for any admin, and erasing people's data, which like setting a
 * retention window takes an admin's own membership. */
function DataProtectionSections({ tenant }: { tenant: TenantMembership }) {
  const { capabilities } = useAuth();
  return (
    <>
      {capabilities.administersWorkspace && (
        <RetentionSection
          tenantId={tenant.id}
          canSetWindow={capabilities.canManageDataProtection}
        />
      )}
      {capabilities.canManageDataProtection && <PeopleSection tenantId={tenant.id} />}
    </>
  );
}

/** Making Public rooms on private channels Private, for any admin. */
function RoomsSections({ tenant }: { tenant: TenantMembership }) {
  const { capabilities } = useAuth();
  if (!capabilities.administersWorkspace) return null;
  return <PrivateChannelRoomsSection tenantId={tenant.id} />;
}

function DeleteSection({ tenant }: { tenant: TenantMembership }) {
  const { capabilities } = useAuth();
  if (!capabilities.canDeleteWorkspace) return null;
  return <DeleteWorkspaceSection tenantId={tenant.id} tenantName={tenant.name} />;
}

export default function WorkspacePage() {
  const { session, canAdminTenant } = useAuth();
  const tenant = session?.tenant;
  if (!tenant) return <CircularProgress />;

  return (
    <Box>
      <WorkspaceHeading tenant={tenant} />
      <Stack spacing={4}>
        <UsersSections session={session} tenant={tenant} canAdmin={canAdminTenant} />
        <DataProtectionSections tenant={tenant} />
        <RoomsSections tenant={tenant} />
        <DeleteSection tenant={tenant} />
      </Stack>
    </Box>
  );
}

/** Workspace settings › General, in the new layout. */
export function WorkspaceGeneralPage() {
  const { session } = useAuth();
  const tenant = session?.tenant;
  if (!tenant) return <CircularProgress />;

  return (
    <Box>
      <WorkspaceHeading tenant={tenant} />
      <Stack spacing={4}>
        <DataProtectionSections tenant={tenant} />
        <RoomsSections tenant={tenant} />
        <DeleteSection tenant={tenant} />
      </Stack>
    </Box>
  );
}

/** Workspace settings › Users, with the invite links, in the new layout. */
export function WorkspaceUsersPage() {
  const { session, canAdminTenant } = useAuth();
  const tenant = session?.tenant;
  if (!tenant) return <CircularProgress />;

  return (
    <Box>
      <Typography variant="h5" mb={3}>
        Users
      </Typography>
      <Stack spacing={4}>
        <UsersSections session={session} tenant={tenant} canAdmin={canAdminTenant} />
      </Stack>
    </Box>
  );
}
