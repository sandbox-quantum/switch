import {
  Alert,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import CenteredCard from "./CenteredCard";

/** Signed in to several workspaces, and this session has not picked one. */
export default function WorkspacePickerPage() {
  const { session, switchTo } = useAuth();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (tenantId: string) => {
    setPending(tenantId);
    setError(null);
    try {
      await switchTo(tenantId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that workspace");
      setPending(null);
    }
  };

  return (
    <CenteredCard title="Choose a workspace" subtitle="You belong to more than one.">
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <List disablePadding>
        {(session?.tenants ?? []).map((tenant) => (
          <ListItemButton
            key={tenant.id}
            onClick={() => choose(tenant.id)}
            disabled={pending !== null}
            sx={{ borderRadius: 1 }}
          >
            <ListItemText
              primary={tenant.name}
              secondary={
                <Typography variant="caption" sx={{ textTransform: "capitalize" }}>
                  {tenant.role}
                </Typography>
              }
            />
          </ListItemButton>
        ))}
      </List>
    </CenteredCard>
  );
}
