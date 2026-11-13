import ShieldOutlined from "@mui/icons-material/ShieldOutlined";
import { Alert, Box, Button, Card, CircularProgress, Link, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { TableEmptyState } from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import { loadWorkspaceGuardrails } from "../../data/api";
import { useLoad } from "../workspace/useLoad";
import GuardrailPolicyCard from "./GuardrailPolicyCard";

const ORGANIZATION_GUARDRAILS = "/settings/org/guardrails";

/** Which Switch Trust policy checks the workspace's messages, for everyone
 *  in it to read. It is set in the organization's settings, so only the
 *  organization's admin, who may open them, is offered a way there. */
export default function WorkspaceGuardrailsPage() {
  const { session, capabilities } = useAuth();
  const { data, error, loading, refetch } = useLoad(loadWorkspaceGuardrails);
  const workspace = session?.tenant?.name;
  if (!workspace) return <CircularProgress />;

  const editLink = (text: string) =>
    capabilities.administersOrganization ? (
      <Link component={RouterLink} to={ORGANIZATION_GUARDRAILS}>
        {text}
      </Link>
    ) : (
      text
    );

  let body: ReactNode;
  if (data === null && loading) {
    body = <CircularProgress aria-label="Loading guardrails" />;
  } else if (data === null) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      >
        Couldn't load the guardrails: {error}
      </Alert>
    );
  } else if (!data.checking || data.policy_id === null) {
    body = (
      <Card variant="outlined" sx={{ borderRadius: "16px", maxWidth: 640 }}>
        <Stack spacing={2} sx={{ alignItems: "center", px: 3, py: 6 }}>
          <ShieldOutlined aria-hidden sx={{ color: "text.secondary" }} />
          <TableEmptyState title="No guardrails configured">
            <>Guardrails are set up at the {editLink("organization level")}.</>
          </TableEmptyState>
        </Stack>
      </Card>
    );
  } else {
    body = <GuardrailPolicyCard policyId={data.policy_id} policyName={data.policy_name} policyUrl={data.policy_url} />;
  }

  const checking = data?.checking === true;
  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5">Guardrails</Typography>
        {checking && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Switch Trust checks every message in {workspace}.
            {capabilities.administersOrganization && <> {editLink("Edit in organization settings")}.</>}
          </Typography>
        )}
      </Box>
      {body}
    </Box>
  );
}
