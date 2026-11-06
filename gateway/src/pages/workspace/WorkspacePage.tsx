import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useAuth } from "../../data/AuthContext";
import DeleteWorkspaceSection from "./DeleteWorkspaceSection";
import InvitationsSection from "./InvitationsSection";
import MembersSection from "./MembersSection";
import PeopleSection from "./PeopleSection";
import RetentionSection from "./RetentionSection";

export default function WorkspacePage() {
  const { session, canAdminTenant } = useAuth();
  const tenant = session?.tenant;
  if (!tenant) return <CircularProgress />;

  return (
    <Box>
      <Stack spacing={0.5} mb={3}>
        <Typography variant="h5">{tenant.name}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          You are {tenant.role === "admin" ? "an admin" : `a ${tenant.role}`} of this workspace.
        </Typography>
      </Stack>
      <Stack spacing={4}>
        <MembersSection tenantId={tenant.id} selfId={session.user.id} />
        {canAdminTenant ? (
          <InvitationsSection
            tenantId={tenant.id}
            inOrganization={tenant.organization_id !== null}
            emailEnabled={session.invite_email_enabled}
          />
        ) : (
          <Alert severity="info">
            Ask a workspace admin to invite someone.
          </Alert>
        )}
        {canAdminTenant && <RetentionSection tenantId={tenant.id} />}
        {tenant.role === "admin" && <PeopleSection tenantId={tenant.id} />}
        {/* An admin membership, not the operator's bypass: the server checks the same. */}
        {tenant.role === "admin" && (
          <DeleteWorkspaceSection tenantId={tenant.id} tenantName={tenant.name} />
        )}
      </Stack>
    </Box>
  );
}
