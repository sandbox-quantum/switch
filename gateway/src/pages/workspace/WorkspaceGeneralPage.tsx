import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useState } from "react";
import EditableField from "../../components/EditableField";
import SuccessSnackbar from "../../components/SuccessSnackbar";
import { type TenantMembership, WORKSPACE_NAME_MAX, renameWorkspace } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import DeleteWorkspaceSection from "./DeleteWorkspaceSection";
import PeopleSection from "./PeopleSection";
import PrivateChannelRoomsSection from "./PrivateChannelRoomsSection";
import RetentionSection from "./RetentionSection";

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

/** The workspace's name, which whoever administers it may change. After a
 * rename the session is read again, and with it every place that shows the
 * name: the breadcrumb, the switcher and the rest. */
function WorkspaceNameField({ tenant }: { tenant: TenantMembership }) {
  const { capabilities, recheck } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);

  const rename = async (draft: string) => {
    const { name } = await renameWorkspace(tenant.id, draft);
    await recheck();
    setNotice(`Workspace renamed to ${name}.`);
  };

  return (
    <>
      <EditableField
        label="Workspace name"
        value={tenant.name}
        canEdit={capabilities.administersWorkspace}
        readOnlyHelper="An org admin or a workspace admin can change this."
        editLabel="Rename workspace"
        maxLength={WORKSPACE_NAME_MAX}
        width={420}
        onSave={rename}
      />
      <SuccessSnackbar message={notice} onClose={() => setNotice(null)} />
    </>
  );
}

/** Workspace settings › General. */
export default function WorkspaceGeneralPage() {
  const { session } = useAuth();
  const tenant = session?.tenant;
  if (!tenant) return <CircularProgress />;

  return (
    <Box>
      <Typography variant="h5" mb={3}>
        General
      </Typography>
      <Stack spacing={4}>
        <WorkspaceNameField tenant={tenant} />
        <DataProtectionSections tenant={tenant} />
        <RoomsSections tenant={tenant} />
        <DeleteSection tenant={tenant} />
      </Stack>
    </Box>
  );
}
