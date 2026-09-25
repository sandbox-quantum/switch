import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useAuth } from "../../data/AuthContext";
import { ownsTenant } from "../../data/sessionState";
import InvitationsSection from "./InvitationsSection";
import MembersSection from "./MembersSection";

export default function WorkspacePage() {
  const { session, canAdminTenant } = useAuth();
  const tenant = session?.tenant;
  if (!tenant) return <CircularProgress />;
  const isOwner = ownsTenant(session);

  return (
    <Box>
      <Stack spacing={0.5} mb={3}>
        <Typography variant="h5">{tenant.name}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          You are {tenant.role === "admin" ? "an admin" : `a ${tenant.role}`} of this workspace.
        </Typography>
      </Stack>
      <Stack spacing={4}>
        <MembersSection
          tenantId={tenant.id}
          selfId={session.user.id}
          canAdmin={canAdminTenant}
          isOwner={isOwner}
        />
        {canAdminTenant ? (
          <InvitationsSection
            tenantId={tenant.id}
            isOwner={isOwner}
            emailEnabled={session.invite_email_enabled}
          />
        ) : (
          <Alert severity="info">
            Ask a workspace owner or admin to invite someone.
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
