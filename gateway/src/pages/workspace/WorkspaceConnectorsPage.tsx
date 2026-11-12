import { Alert, Box, Button, CircularProgress, Stack, Tooltip, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import CatalogueGrid from "../../components/connectors/CatalogueGrid";
import ConnectorAvailability from "../../components/connectors/ConnectorAvailability";
import ConnectorCard from "../../components/connectors/ConnectorCard";
import ConfirmDialog from "../../components/ConfirmDialog";
import PageBanner from "../../components/PageBanner";
import { useAuth } from "../../data/AuthContext";
import {
  type UnavailableCode,
  type WorkspaceService,
  type WorkspaceServices,
  clearWorkspaceService,
  fetchWorkspaceServices,
  setWorkspaceService,
} from "../../data/api";
import { useLoad } from "./useLoad";

/** What stops anyone here using a connector, in a few words for the card's
 * one line, for every reason the server gives. The server's own sentence is
 * longer; a reason it adds later shows that sentence, or failing that a word
 * that still says it can't be used. */
export const UNAVAILABLE: Record<UnavailableCode, string> = {
  coming_soon: "Coming soon",
  switched_off: "Turned off in Switch's configuration",
  needs_https: "Can't be set up here",
  needs_public_url: "Can't be set up here",
  app_not_set_up: "Switch's app isn't set up",
  not_set_up: "Not offered here",
  organization_app_unusable: "Your organization's app isn't working",
  not_fully_set_up: "Its app isn't fully set up",
  key_never_expires: "Never handed to agents",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Which setting decides it, in the card's words. */
function deciderText(service: WorkspaceService, organization: string): string {
  switch (service.decided_by) {
    case "organization_locked":
      return `Set by ${organization}`;
    case "organization_default":
      return `${organization}'s default`;
    case "workspace":
      return service.updated_by_name ? `Set here by ${service.updated_by_name}` : "Set here";
    case "workspace_default":
      return service.enabled ? "On by default" : "Off by default";
  }
}

/** "Set by Acme · Your organization's app · 2 people, 1 agent": one line,
 * so who it reaches is said only when anyone is reached. */
export function metaText(service: WorkspaceService, organization: string): string {
  const parts = [deciderText(service, organization)];
  if (service.unavailable_code !== null) {
    const code = service.unavailable_code;
    parts.push((code in UNAVAILABLE ? UNAVAILABLE[code as UnavailableCode] : service.unavailable_reason) ?? "Unavailable");
  } else if (service.auth_type === "oauth") {
    parts.push(service.app_source === "organization" ? "Your organization's app" : "Switch's app");
  }
  const members = service.connected_members ?? 0;
  const agents = service.granted_agents ?? 0;
  if (members > 0 || agents > 0)
    parts.push(`${plural(members, "person", "people")}, ${plural(agents, "agent", "agents")}`);
  return parts.filter(Boolean).join(" · ");
}

/** Who loses a connector a change would leave off, for the confirmation; null
 * when nobody does, or the change leaves it on. */
function offConfirmation(service: WorkspaceService, enabled: boolean, workspace: string) {
  const members = service.connected_members ?? 0;
  const agents = service.granted_agents ?? 0;
  if (enabled || !service.enabled || (members === 0 && agents === 0)) return null;
  return {
    title: `Turn ${service.name} off for ${workspace}?`,
    description:
      `${plural(members, "person has", "people have")} it connected and ` +
      `${plural(agents, "agent uses", "agents use")} it. Their sessions lose it within a minute. ` +
      "Turning it back on gives their access back.",
  };
}

/** Where dropping the workspace's own setting leaves a connector: its
 * organization's unlocked default where it has one, else the workspace's. */
function defaultOf(service: WorkspaceService, data: WorkspaceServices): { enabled: boolean; whose: string } {
  if (service.organization_default !== null)
    return { enabled: service.organization_default, whose: `${data.organization_name ?? "your organization"}'s` };
  return { enabled: data.on_by_default, whose: "this workspace's" };
}

interface Change {
  service: WorkspaceService;
  /** Whether it is on once the change is made. */
  enabled: boolean;
  run: () => Promise<{ warning: string | null }>;
}

/**
 * Workspace settings › Connectors: which connectors this workspace may use,
 * inside its organization's policy. Everyone sees each one's state and what
 * decides it; its admins switch what the organization has not locked. A
 * switch shows what the server says: it never flips before the server has
 * answered, and a refusal (the organization locked it meanwhile, say) is
 * shown with the page read again.
 */
export default function WorkspaceConnectorsPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const load = useCallback(() => fetchWorkspaceServices(), []);
  const { data, error, loading, refetch } = useLoad<WorkspaceServices>(load);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Change | null>(null);

  const workspace = session?.tenant?.name ?? "this workspace";
  const organization = data?.organization_name ?? "your organization";

  // Rethrows, so the confirmation shows a refusal in place; the page is read
  // again either way.
  const apply = async (change: Change) => {
    setPending(change.service.slug);
    setActionError(null);
    setActionWarning(null);
    try {
      const { warning } = await change.run();
      setActionWarning(warning);
    } finally {
      setPending(null);
      await refetch();
    }
  };

  const request = (change: Change) => {
    if (pending !== null) return;
    if (offConfirmation(change.service, change.enabled, workspace)) {
      setConfirming(change);
      return;
    }
    apply(change).catch((err: unknown) =>
      setActionError(err instanceof Error ? err.message : "The change failed"),
    );
  };

  const switchTo = (service: WorkspaceService, enabled: boolean) =>
    request({ service, enabled, run: () => setWorkspaceService(service.slug, enabled) });

  const goBackToDefault = (service: WorkspaceService, enabled: boolean) =>
    request({ service, enabled, run: () => clearWorkspaceService(service.slug) });

  const confirmation = confirming && offConfirmation(confirming.service, confirming.enabled, workspace);

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Connectors
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Choose which connectors people in {workspace} can connect and give to their agents.
        {data &&
          ` Connectors nobody has set${data.organization_name ? `, here or in ${data.organization_name},` : ""} are ${
            data.on_by_default ? "on" : "off"
          }.`}
      </Typography>
      <Stack spacing={2}>
        {data && !data.can_change && (
          <PageBanner tone="neutral">
            Only this workspace&apos;s admins can change which connectors it uses.
          </PageBanner>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        {actionWarning && (
          <Alert severity="warning" onClose={() => setActionWarning(null)}>
            {actionWarning}
          </Alert>
        )}
        {loading ? (
          <CircularProgress aria-label="Loading connectors" />
        ) : (
          data && (
            <Box>
              <CatalogueGrid
                connectors={data.services}
                query={query}
                onQueryChange={setQuery}
                emptyMessage={
                  query.trim() ? `No connectors match "${query.trim()}".` : "No connectors are offered here yet."
                }
                renderCard={(service) => {
                  const offEverywhere = service.unavailable_code === "switched_off";
                  const lockedOff = service.decided_by === "organization_locked" && !service.enabled;
                  const fallback = service.can_change && service.decided_by === "workspace" ? defaultOf(service, data) : null;
                  return (
                    <ConnectorCard
                      connector={service}
                      meta={metaText(service, organization)}
                      onOpen={() => navigate(`/connectors/${service.slug}`)}
                      trailing={
                        <Stack spacing={0.5} sx={{ alignItems: "flex-end" }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                            {pending === service.slug && (
                              <CircularProgress size={16} aria-label={`Changing ${service.name}`} />
                            )}
                            <ConnectorAvailability
                              available={service.enabled}
                              connectorName={service.name}
                              scopeName={workspace}
                              turnedOffBy={offEverywhere ? "everyone" : lockedOff ? organization : null}
                              onChange={
                                service.can_change
                                  ? (enabled) => switchTo(service, enabled)
                                  : null
                              }
                            />
                          </Stack>
                          {fallback && (
                            <Tooltip title={`Use ${fallback.whose} default: ${fallback.enabled ? "on" : "off"}`}>
                              {/* A disabled button fires no events, so the tooltip listens on this. */}
                              <span>
                                <Button
                                  size="small"
                                  variant="text"
                                  disabled={pending !== null}
                                  onClick={() => goBackToDefault(service, fallback.enabled)}
                                  aria-label={`Use ${fallback.whose} default for ${service.name}: ${
                                    fallback.enabled ? "on" : "off"
                                  }`}
                                >
                                  Use default
                                </Button>
                              </span>
                            </Tooltip>
                          )}
                        </Stack>
                      }
                    />
                  );
                }}
              />
            </Box>
          )
        )}
      </Stack>
      {confirming && confirmation && (
        <ConfirmDialog
          open
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel="Turn off"
          tone="destructive"
          onConfirm={() => apply(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </Box>
  );
}
