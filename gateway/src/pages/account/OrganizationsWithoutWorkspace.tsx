import { Alert, Button, Stack } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import {
  type OrganizationWithoutWorkspace,
  fetchOrganizationsWithoutWorkspace,
  leaveOrganization,
} from "../../data/api";

/** The organizations you're still in after being removed from your last
 * workspace there, each with a way to leave it. Nothing when there are none;
 * a failure to read them says so. */
export default function OrganizationsWithoutWorkspace() {
  const [organizations, setOrganizations] = useState<OrganizationWithoutWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<OrganizationWithoutWorkspace | null>(null);
  const [left, setLeft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrganizations(await fetchOrganizationsWithoutWorkspace());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <Alert severity="error">
        Couldn't check which organizations you're still in: {error}
      </Alert>
    );
  }
  if (organizations === null || (organizations.length === 0 && left === null)) return null;

  return (
    <Stack spacing={1}>
      {left !== null && (
        <Alert severity="success" onClose={() => setLeft(null)}>
          You left {left}.
        </Alert>
      )}
      {organizations.map((organization) => (
        <Alert
          key={organization.id}
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={() => setLeaving(organization)}>
              Leave
            </Button>
          }
        >
          You're still in {organization.name}, though in none of its workspaces.
        </Alert>
      ))}
      <ConfirmDialog
        open={leaving !== null}
        title={`Leave ${leaving?.name ?? ""}?`}
        description={`You'll no longer be part of ${leaving?.name ?? ""}. Its admins can invite you back.`}
        confirmLabel="Leave"
        tone="destructive"
        onConfirm={async () => {
          if (leaving === null) return;
          await leaveOrganization(leaving.id);
          setLeft(leaving.name);
          await load();
        }}
        onClose={() => setLeaving(null)}
      />
    </Stack>
  );
}
