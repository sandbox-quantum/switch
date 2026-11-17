import { Alert, Box, Button, CircularProgress, Link, Stack, Tooltip, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import CatalogueGrid from "../../components/connectors/CatalogueGrid";
import ConnectorAvailability from "../../components/connectors/ConnectorAvailability";
import ConnectorCard from "../../components/connectors/ConnectorCard";
import ConfirmDialog from "../../components/ConfirmDialog";
import InfoTip from "../../components/InfoTip";
import SuccessSnackbar from "../../components/SuccessSnackbar";
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

/** What stops anyone here using it, in the card's few words. */
function unavailableText(service: WorkspaceService): string {
  const code = service.unavailable_code;
  if (code === null) throw new Error(`${service.slug} is not unavailable`);
  return (code in UNAVAILABLE ? UNAVAILABLE[code as UnavailableCode] : service.unavailable_reason) ?? "Unavailable";
}

/** Whether nobody here can use it whatever the switch says (its app isn't set
 * up, say), so the switch would decide nothing. One whose app is missing a
 * part can still be connected, so its switch still decides that. Switch's own
 * configuration having it off is said as "Off for everyone" instead. */
function unusable(service: WorkspaceService): boolean {
  const code = service.unavailable_code;
  return code !== null && code !== "switched_off" && code !== "not_fully_set_up";
}

function lockedOff(service: WorkspaceService): boolean {
  return service.decided_by === "organization_locked" && !service.enabled;
}

/** Why the switch can't decide it here, said in its place: Switch's own
 * configuration or the organization has it off, or nobody here can use it
 * anyway. Null where the switch decides. */
export function blockedText(service: WorkspaceService, organization: string): string | null {
  if (service.unavailable_code === "switched_off") return "Off for everyone";
  if (lockedOff(service)) return `Off for ${organization}`;
  return unusable(service) ? unavailableText(service) : null;
}

/** What a connector nobody has set is left as, for the page's info tip. */
export function defaultsTip(data: Pick<WorkspaceServices, "on_by_default" | "organization_name">): string {
  const state = data.on_by_default ? "on" : "off";
  const org = data.organization_name;
  if (org === null) return `Connectors nobody has set here are ${state}.`;
  return `Connectors nobody has set, here or in ${org}, are ${state}. Whether one exists for ${org} at all is set in Organization settings › Connectors.`;
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
 * so who it reaches is said only when anyone is reached. What stops anyone
 * using it is said here unless it is said in place of the switch. */
export function metaText(service: WorkspaceService, organization: string): string {
  const parts = [deciderText(service, organization)];
  if (service.unavailable_code !== null) {
    if (!unusable(service) || lockedOff(service)) parts.push(unavailableText(service));
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
  const { session, capabilities } = useAuth();
  const navigate = useNavigate();
  const load = useCallback(() => fetchWorkspaceServices(), []);
  const { data, error, loading, refetch } = useLoad<WorkspaceServices>(load);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Change | null>(null);

  const workspace = session?.tenant?.name ?? "this workspace";
  const organization = data?.organization_name ?? "your organization";
  const administers = data?.can_change ?? capabilities.administersWorkspace;

  // Rethrows, so the confirmation shows a refusal in place; the page is read
  // again either way. A change that leaves something still usable says so on
  // the page, in place of saying it worked.
  const apply = async (change: Change) => {
    setPending(change.service.slug);
    setActionError(null);
    setActionWarning(null);
    try {
      const { warning } = await change.run();
      setActionWarning(warning);
      if (warning === null)
        setDone(
          change.enabled
            ? `${change.service.name} is available in ${workspace}.`
            : `${change.service.name} is off for ${workspace}. Nobody can connect it here until it is switched back on.`,
        );
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
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ mb: 3, alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="body2" color="text.secondary">
          {administers
            ? `Choose which connectors ${workspace} can use.`
            : `Which connectors ${workspace} can use. Only its admins can change this.`}
          {" To give your agents access, go to "}
          <Link component={RouterLink} to="/connectors">
            Connectors
          </Link>
          .
        </Typography>
        {data && <InfoTip>{defaultsTip(data)}</InfoTip>}
      </Stack>
      <Stack spacing={2}>
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
                emptyMessage={query.trim() ? "No connectors match that search." : "No connectors are offered here yet."}
                renderCard={(service) => {
                  const blocked = blockedText(service, organization);
                  // A way back to a default would decide no more than the switch.
                  const fallback =
                    blocked === null && service.can_change && service.decided_by === "workspace"
                      ? defaultOf(service, data)
                      : null;
                  return (
                    <ConnectorCard
                      connector={service}
                      meta={metaText(service, organization)}
                      onOpen={() =>
                        navigate(`/connectors/${service.slug}`, {
                          state: { back: { label: "Settings", to: "/settings/connectors" } },
                        })
                      }
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
                              blocked={blocked}
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
      <SuccessSnackbar message={done} onClose={() => setDone(null)} />
    </Box>
  );
}
