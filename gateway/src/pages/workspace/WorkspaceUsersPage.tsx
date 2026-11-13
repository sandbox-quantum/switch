import Add from "@mui/icons-material/Add";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { type Session, type TenantMembership, fetchMembers } from "../../data/api";
import { type Capabilities, organizationAdmins } from "../../data/capabilities";
import CreateInvitationDialog from "./CreateInvitationDialog";
import InviteLinksSection from "./InviteLinksSection";
import UsersTable from "./UsersTable";
import { useLoad } from "./useLoad";

/** Workspace settings › Users: everyone in the workspace, and for those who
 * administer it, the invite links that bring people in. A member sees the
 * roster read-only. */
export default function WorkspaceUsersPage() {
  const { session, capabilities, refresh } = useAuth();
  const [inviteOpen, setInviteOpen] = useState(false);
  // What the last removal handed over, and what it could not revoke. Held
  // here, above the roster, so they are still shown after leaving, when the
  // roster starts again for the workspace the session is on now.
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const onRemoved = useCallback((removedNotice: string, removedWarning: string | null) => {
    setNotice(removedNotice);
    setWarning(removedWarning);
  }, []);

  const tenant = session?.tenant ?? null;
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
      {(notice !== null || warning !== null) && (
        <Stack spacing={1.5} sx={{ mb: 3 }}>
          {notice !== null && (
            <Alert severity="info" onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          )}
          {warning !== null && (
            <Alert severity="warning" onClose={() => setWarning(null)}>
              {warning}
            </Alert>
          )}
        </Stack>
      )}
      {/* Keyed on the workspace, so a change of workspace (leaving this one,
          say) starts the roster and links again rather than showing the last
          workspace's under this one's name, where a row's action would ask
          about someone who is not here. */}
      <Roster
        key={tenant.id}
        session={session}
        tenant={tenant}
        capabilities={capabilities}
        onRemoved={onRemoved}
        onSessionChanged={refresh}
      />
      {administers && (
        <CreateInvitationDialog
          open={inviteOpen}
          tenantId={tenant.id}
          fromOrganization={false}
          workspaceName={tenant.name}
          emailEnabled={session.invite_email_enabled}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </Box>
  );
}

function Roster({
  session,
  tenant,
  capabilities,
  onRemoved,
  onSessionChanged,
}: {
  session: Session;
  tenant: TenantMembership;
  capabilities: Capabilities;
  onRemoved: (notice: string, warning: string | null) => void;
  /** Read the session again: after stepping down, what this person may do
   * here has changed; after leaving, it is on another workspace, or none. */
  onSessionChanged: () => Promise<void>;
}) {
  const load = useCallback(() => fetchMembers(tenant.id), [tenant.id]);
  const members = useLoad(load);
  const administers = capabilities.administersWorkspace;

  return (
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
            onSelfChanged={onSessionChanged}
            onRemoved={onRemoved}
            onLeft={onSessionChanged}
          />
        )
      )}
      {administers && (
        <InviteLinksSection
          tenantId={tenant.id}
          inOrganization={tenant.organization_id !== null}
          members={members.data}
        />
      )}
    </Stack>
  );
}
