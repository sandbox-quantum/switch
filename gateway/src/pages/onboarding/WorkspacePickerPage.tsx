import ChevronRightOutlined from "@mui/icons-material/ChevronRightOutlined";
import {
  Alert,
  Box,
  CircularProgress,
  List,
  ListItem,
  ListItemButton,
  ListSubheader,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import type { TenantMembership } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import {
  type OrganizationName,
  loadOrganizationNames,
  switcherSections,
} from "../../data/workspaceSwitcher";
import AuthLayout, { SignedInFooter } from "../auth/AuthLayout";

type NamesState =
  | { status: "loading" }
  | { status: "loaded"; organizations: OrganizationName[] }
  | { status: "failed"; message: string };

function WorkspaceRow({
  workspace,
  pending,
  disabled,
  onChoose,
}: {
  workspace: TenantMembership;
  pending: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <ListItem disablePadding>
      <ListItemButton
        onClick={onChoose}
        disabled={disabled}
        sx={{
          gap: 1.5,
          px: 2,
          py: 1.25,
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          backgroundColor: "background.paper",
        }}
      >
        <Box
          aria-hidden
          sx={{
            width: 36,
            height: 36,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 1,
            backgroundColor: "background.surface",
            typography: "subtitle2",
          }}
        >
          {workspace.name.charAt(0).toUpperCase()}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
            {workspace.name}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary", textTransform: "capitalize" }}>
            {workspace.role}
          </Typography>
        </Box>
        {pending ? (
          <CircularProgress size={16} aria-label={`Opening ${workspace.name}`} />
        ) : (
          <ChevronRightOutlined sx={{ fontSize: 18, color: "text.secondary" }} />
        )}
      </ListItemButton>
    </ListItem>
  );
}

/** Signed in to several workspaces, and this session has not picked one.
 * They are listed by organization, as the top bar's switcher lists them. */
export default function WorkspacePickerPage() {
  const { session, switchTo } = useAuth();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<NamesState>({ status: "loading" });

  // No workspace is selected yet, so there is no current one to name.
  useEffect(() => {
    let cancelled = false;
    loadOrganizationNames(null).then(
      (organizations) => {
        if (!cancelled) setNames({ status: "loaded", organizations });
      },
      (err: unknown) => {
        if (!cancelled) {
          setNames({
            status: "failed",
            message: err instanceof Error ? err.message : "Could not load the organizations",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

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

  const { sections, headed } = switcherSections(
    session?.tenants ?? [],
    names.status === "loaded" ? names.organizations : [],
  );

  return (
    <AuthLayout
      title="Choose a workspace"
      subtitle="You're in more than one. You can switch later."
      footer={<SignedInFooter />}
    >
      {names.status === "loading" ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
          <CircularProgress size={24} aria-label="Loading your workspaces" />
        </Box>
      ) : (
        <Stack spacing={2}>
          {names.status === "failed" && (
            <Alert severity="warning">
              Could not load the organizations' names, so the workspaces are not grouped:{" "}
              {names.message}
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {sections.map((section) => (
            <List
              key={section.organizationId ?? "none"}
              disablePadding
              aria-label={headed ? (section.name ?? "No organization") : "Workspaces"}
              subheader={
                headed ? (
                  <ListSubheader
                    disableSticky
                    sx={{ px: 0, lineHeight: "24px", mb: 0.5, backgroundColor: "transparent" }}
                  >
                    {section.name ?? "No organization"}
                  </ListSubheader>
                ) : undefined
              }
              sx={{ display: "flex", flexDirection: "column", gap: 1 }}
            >
              {section.workspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  pending={pending === workspace.id}
                  disabled={pending !== null}
                  onChoose={() => choose(workspace.id)}
                />
              ))}
            </List>
          ))}
        </Stack>
      )}
    </AuthLayout>
  );
}
