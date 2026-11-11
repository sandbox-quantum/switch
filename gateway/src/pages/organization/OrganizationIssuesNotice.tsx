import { Alert, AlertTitle, Box } from "@mui/material";
import { useCallback } from "react";
import { type OrganizationIssue, fetchOrganizationIssues } from "../../data/api";
import { useLoad } from "../workspace/useLoad";

function describe(issue: OrganizationIssue): string {
  const workspace = issue.workspace_name ?? "";
  switch (issue.kind) {
    case "no_org_admin":
      return "Nobody is an admin of this organization. Make one of its users an organization admin below.";
    case "workspace_without_admin":
      return `${workspace} has no admin. Make one of its users an admin in that workspace's settings.`;
    case "agents_without_acting_owner":
      return (
        `In ${workspace}, these agents are owned by someone who is no longer in the ` +
        `workspace, so nobody can act for them as their owner: ${issue.agents.join(", ")}. ` +
        "Delete them from that workspace's agents if they are no longer needed."
      );
    case "directory_organization_deleted":
      return (
        "The WorkOS organization this organization follows was deleted. Its users are " +
        "left as they were; ask whoever runs Switch to link it again or remove it."
      );
  }
}

/** What needs an organization admin's attention, shown until it is fixed.
 * Nothing at all when there is nothing, or when the caller is not one the
 * server answers (the platform operator while the organization has admins). */
export default function OrganizationIssuesNotice() {
  const load = useCallback(() => fetchOrganizationIssues(), []);
  const { data: issues, error, errorStatus } = useLoad(load);
  if (errorStatus === 403) return null;
  if (error) {
    return <Alert severity="error">Could not check this organization for problems: {error}</Alert>;
  }
  if (!issues || issues.length === 0) return null;
  return (
    <Alert severity="warning">
      <AlertTitle>
        {issues.length === 1 ? "One thing needs your attention" : `${issues.length} things need your attention`}
      </AlertTitle>
      <Box component="ul" sx={{ m: 0, pl: 2 }}>
        {issues.map((issue) => (
          <li key={`${issue.kind}:${issue.workspace_id ?? ""}`}>{describe(issue)}</li>
        ))}
      </Box>
    </Alert>
  );
}
