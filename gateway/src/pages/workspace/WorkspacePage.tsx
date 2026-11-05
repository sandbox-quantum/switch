import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import type { Session, TenantMembership } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import DeleteWorkspaceSection from "./DeleteWorkspaceSection";
import InvitationsSection from "./InvitationsSection";
import MembersSection from "./MembersSection";

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
      <MembersSection tenantId={tenant.id} selfId={session.user.id} canAdmin={canAdmin} />
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

function DeleteSection({ tenant }: { tenant: TenantMembership }) {
  // An admin membership, not the operator's bypass: the server checks the same.
  if (tenant.role !== "admin") return null;
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
