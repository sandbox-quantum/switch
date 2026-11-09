import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { fetchCurrentOrganization, fetchFeatureFlags } from "../../data/api";
import { administersOrganization } from "../../data/sessionState";
import { useLoad } from "../workspace/useLoad";
import OrganizationAuditSection from "./OrganizationAuditSection";
import OrganizationConnectorsSection from "./OrganizationConnectorsSection";
import OrganizationServicesSection from "./OrganizationServicesSection";
import OrganizationIssuesNotice from "./OrganizationIssuesNotice";
import OrganizationMembersSection from "./OrganizationMembersSection";
import WorkspacesSection from "./WorkspacesSection";

/** The organization the current workspace belongs to. Its workspaces are
 * listed to anyone in it; its members and audit log to its admins, the only
 * ones the server answers. */
export default function OrganizationPage() {
  const { session } = useAuth();
  const load = useCallback(() => fetchCurrentOrganization(), []);
  const { data: organization, error } = useLoad(load);
  const isAdmin = session ? administersOrganization(session) : false;
  // Only an org admin sees the sections the flags decide, so only they ask.
  const loadFlags = useCallback(
    () => (isAdmin ? fetchFeatureFlags() : Promise.resolve(null)),
    [isAdmin],
  );
  const { data: flags, error: flagsError } = useLoad(loadFlags);
  // The server mounts the routes behind Services and Connectors only with
  // both flags on; asking a server without them would only be refused.
  const organizationApps =
    flags?.service_connections === true && flags?.organization_connector_apps === true;
  // A change to the members can make an issue or settle one; the notice is
  // read again, from scratch, after each.
  const [membersChanged, setMembersChanged] = useState(0);
  const onMembersChanged = useCallback(() => setMembersChanged((n) => n + 1), []);
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;
  if (tenant.organization_id === null) {
    return <Alert severity="info">This workspace belongs to no organization.</Alert>;
  }

  return (
    <Box>
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
      {error && <Alert severity="error">{error}</Alert>}
      {flagsError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not tell whether Services and Connectors are available: {flagsError}
        </Alert>
      )}
      <Stack spacing={4}>
        {(isAdmin || session.user.is_operator) && <OrganizationIssuesNotice key={membersChanged} />}
        <WorkspacesSection currentId={tenant.id} canAdd={session.can_add_workspace} />
        {(isAdmin || session.user.is_operator) && (
          <OrganizationMembersSection
            selfId={session.user.id}
            organizationId={tenant.organization_id}
            asOperator={!isAdmin}
            fromDirectory={organization?.members_from_directory === true}
            directoryTakesChanges={organization?.directory_takes_changes === true}
            onChanged={onMembersChanged}
          />
        )}
        {isAdmin && organizationApps && <OrganizationServicesSection />}
        {isAdmin && organizationApps && <OrganizationConnectorsSection />}
        {isAdmin && <OrganizationAuditSection />}
      </Stack>
    </Box>
  );
}
