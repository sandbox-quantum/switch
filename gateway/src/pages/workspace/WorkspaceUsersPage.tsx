import Add from "@mui/icons-material/Add";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { fetchMembers } from "../../data/api";
import { organizationAdmins } from "../../data/capabilities";
import CreateInvitationDialog from "./CreateInvitationDialog";
import InviteLinksSection from "./InviteLinksSection";
import UsersTable from "./UsersTable";
import { useLoad } from "./useLoad";

/** Workspace settings › Users: everyone in the workspace, and for those who
 * administer it, the invite links that bring people in. A member sees the
 * roster read-only. */
export default function WorkspaceUsersPage() {
  const { session, capabilities, refresh } = useAuth();
  const tenant = session?.tenant ?? null;
  const tenantId = tenant?.id ?? null;
  const load = useCallback(
    () => (tenantId === null ? Promise.resolve([]) : fetchMembers(tenantId)),
    [tenantId],
  );
  const members = useLoad(load);
  const [inviteOpen, setInviteOpen] = useState(false);

  if (!session || !tenant) return <CircularProgress />;
  const administers = capabilities.administersWorkspace;

  return (
    <Box>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}
      >
        <Stack spacing={0.5}>
          <Typography variant="h5">Users</Typography>
          <Typography variant="body2" color="text.secondary">
            Everyone in {tenant.name}.
            {!administers && " Ask a workspace admin to invite someone."}
          </Typography>
        </Stack>
        {administers && (
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={() => setInviteOpen(true)}
            sx={{ flexShrink: 0 }}
          >
            Invite users
          </Button>
        )}
      </Stack>
      <Stack spacing={5}>
        {members.error !== null && <Alert severity="error">{members.error}</Alert>}
        {members.loading ? (
          <CircularProgress />
        ) : (
          members.data !== null && (
            <UsersTable
              tenantId={tenant.id}
              workspaceName={tenant.name}
              members={members.data}
              selfId={session.user.id}
              administers={administers}
              // Organization settings › Users admits whoever may enter the area.
              canOpenOrganizationUsers={organizationAdmins(capabilities).allowed}
              onChanged={members.refetch}
              onSelfChanged={refresh}
              // The session moved off this workspace when they left: read it
              // again, and the page follows it to wherever it is now.
              onLeft={refresh}
            />
          )
        )}
        {administers && (
          <InviteLinksSection
            tenantId={tenant.id}
            inOrganization={tenant.organization_id !== null}
            members={members.data ?? []}
          />
        )}
      </Stack>
      {administers && (
        <CreateInvitationDialog
          open={inviteOpen}
          tenantId={tenant.id}
          workspaceName={tenant.name}
          emailEnabled={session.invite_email_enabled}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </Box>
  );
}
