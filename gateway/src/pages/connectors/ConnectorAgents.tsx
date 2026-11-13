import AddOutlined from "@mui/icons-material/AddOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import {
  type GitHubConnection,
  type GrantedAgent,
  type ServiceAgent,
  type ServiceConnection,
  type ServiceGrant,
  removeServiceGrant,
  setServiceGrant,
  githubThroughApp,
} from "../../data/api";
import { GitHubGrantForm, REMOVED_NOTE, repositoryNames } from "../agents/ServiceAccessSection";
import { grantLabel, openAgentNote } from "./connectorProfile";

function repositoryCount(grant: ServiceGrant): number {
  const ids = grant.resources.repository_ids;
  return Array.isArray(ids) ? ids.length : 0;
}

/** A GitHub grant's repositories by name, where the viewer's own GitHub
 * reaches them all: someone else's agent's, or one the viewer can no longer
 * see, is counted instead of listed by number. */
function repositoryNamesIfKnown(github: GitHubConnection | null, grant: ServiceGrant): string[] | null {
  if (github?.status !== "connected") return null;
  const installation = github.installations.find((i) => i.id === grant.resources.installation_id);
  if (!installation) return null;
  const names = repositoryNames(github, grant);
  return names.length === repositoryCount(grant) &&
    names.every((name) => installation.repositories.some((r) => r.name === name))
    ? names
    : null;
}

interface Entry {
  agentId: string;
  name: string;
  /** Someone else's agent, by its owner's name; null for the viewer's own. */
  ownerName: string | null;
  grant: ServiceGrant;
  addressingOpen: boolean;
}

/** The agents to draw: every one in the workspace for an admin, only their
 * own for anyone else. Someone else's is named by its owner, the only thing
 * an admin can act on: nobody grants on another person's connector. */
function entriesOf(
  own: ServiceAgent[],
  workspace: GrantedAgent[] | null,
  meId: string,
): Entry[] {
  if (workspace !== null)
    return workspace.map((agent) => ({
      agentId: agent.agent_id,
      name: agent.name,
      ownerName: agent.owner_id === meId ? null : agent.owner_name,
      grant: agent.grant,
      addressingOpen: agent.addressing_open,
    }));
  return own
    .filter((agent) => agent.grant !== null)
    .map((agent) => ({
      agentId: agent.agent_id,
      name: agent.name,
      ownerName: null,
      grant: agent.grant!,
      addressingOpen: agent.addressing_open,
    }));
}

function AgentCard({
  entry,
  connection,
  github,
  busy,
  onManage,
  onRemove,
}: {
  entry: Entry;
  connection: ServiceConnection;
  github: GitHubConnection | null;
  busy: boolean;
  onManage: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  const repositories = githubThroughApp(connection) ? repositoryNamesIfKnown(github, entry.grant) : null;
  const count = repositoryCount(entry.grant);
  const detail = [
    entry.ownerName,
    repositories?.length === 1
      ? repositories[0]
      : count === 0
        ? null
        : count === 1
          ? "1 repository"
          : `${count} repositories`,
  ].filter(Boolean);
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ alignItems: "flex-start", p: 1.5, border: "1px solid var(--sw-border)", borderRadius: "10px" }}
      data-testid={`connector-agent-${entry.agentId}`}
    >
      <Box
        aria-hidden
        sx={{
          width: 36,
          height: 36,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--sw-border)",
          borderRadius: "8px",
          backgroundColor: "var(--sw-muted)",
          color: "var(--sw-muted-foreground)",
        }}
      >
        <SmartToyOutlined fontSize="small" />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {entry.name}
          </Typography>
          <Chip size="small" variant="outlined" label={grantLabel(entry.grant, connection.pass_through)} />
        </Stack>
        {detail.length > 0 && (
          <Typography variant="body2" color="text.secondary" noWrap title={repositories?.join(", ")}>
            {detail.join(" · ")}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          {entry.grant.summary}
        </Typography>
        {entry.addressingOpen && (
          <Typography variant="caption" color="text.secondary">
            {openAgentNote(entry.ownerName)}
          </Typography>
        )}
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
        {onManage && (
          <Button size="small" disabled={busy} onClick={onManage}>
            Manage
          </Button>
        )}
        {onRemove && (
          <Button size="small" color="error" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

/**
 * The agents using a connector here: a card each, and "Add agent" for the
 * viewer's own. A connector whose agents use their owner's own token is on
 * or off for an agent; GitHub's grant names repositories, from its picker.
 * What else a grant may narrow, its tools, is not offered here yet.
 */
export default function ConnectorAgents({
  connection,
  own,
  workspace,
  meId,
  workspaceName,
  github,
  githubError,
  onChanged,
}: {
  connection: ServiceConnection;
  own: ServiceAgent[];
  /** Every agent granted it in the workspace, for an admin; null for anyone else. */
  workspace: GrantedAgent[] | null;
  meId: string;
  workspaceName: string;
  github: GitHubConnection | null;
  githubError: string | null;
  onChanged: (notice: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<ServiceAgent | null>(null);
  const [managing, setManaging] = useState<Entry | null>(null);
  const isGitHub = githubThroughApp(connection);
  const entries = entriesOf(own, workspace, meId);
  const addable = own.filter((agent) => !agent.granted && agent.grantable);
  const usable =
    connection.status === "active" &&
    connection.workspace_enabled &&
    connection.unavailable_reason === null;

  const act = async (run: () => Promise<{ warning: string | null }>, after: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const { warning } = await run();
      setAdding(false);
      setChosen(null);
      setManaging(null);
      onChanged([warning, after].filter(Boolean).join(" ") || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const grantGitHub = (agentId: string) => (access: "read" | "write", resources: Record<string, unknown>) =>
    void act(() => setServiceGrant(agentId, "github", { access, resources }), null);

  return (
    <Stack spacing={1.5} component="section" aria-label="Agents">
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography variant="h6">Agents</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {entries.length === 1 ? "1 agent" : `${entries.length} agents`}
        </Typography>
        {usable && addable.length > 0 && (
          <Button variant="outlined" size="small" startIcon={<AddOutlined />} onClick={() => setAdding(true)}>
            Add agent
          </Button>
        )}
      </Stack>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {workspace !== null
            ? `No agent in ${workspaceName} uses ${connection.name} yet.`
            : `None of your agents uses ${connection.name} yet.`}
        </Typography>
      ) : (
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" } }}>
          {entries.map((entry) => (
            <AgentCard
              key={entry.agentId}
              entry={entry}
              connection={connection}
              github={github}
              busy={busy}
              onManage={entry.ownerName === null && isGitHub && usable ? () => setManaging(entry) : null}
              onRemove={
                entry.ownerName === null
                  ? () => void act(() => removeServiceGrant(entry.agentId, connection.slug), REMOVED_NOTE)
                  : null
              }
            />
          ))}
        </Box>
      )}

      <Dialog open={adding} onClose={busy ? undefined : () => setAdding(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add an agent to {connection.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Autocomplete
              options={addable}
              getOptionLabel={(agent) => agent.name}
              value={chosen}
              onChange={(_, agent) => setChosen(agent)}
              renderInput={(params) => <TextField {...params} label="Your agent" />}
            />
            {chosen?.addressing_open && <Alert severity="warning">{openAgentNote(null)}</Alert>}
            {!isGitHub && (
              <Typography variant="body2" color="text.secondary">
                It acts as you at {connection.name}, with what you allowed when you connected it.
              </Typography>
            )}
            {isGitHub && chosen && (
              <GitHubGrantForm
                github={github}
                githubError={githubError}
                current={null}
                readOnlyReason={connection.read_only_reason}
                busy={busy}
                onCancel={null}
                onSave={grantGitHub(chosen.agent_id)}
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)} disabled={busy}>
            Cancel
          </Button>
          {!isGitHub && (
            <Button
              variant="contained"
              disabled={busy || chosen === null}
              onClick={() =>
                chosen &&
                void act(() => setServiceGrant(chosen.agent_id, connection.slug, { access: null, resources: {} }), null)
              }
            >
              Add
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {managing && (
        <Dialog open onClose={busy ? undefined : () => setManaging(null)} maxWidth="sm" fullWidth>
          <DialogTitle>{managing.name}&apos;s GitHub access</DialogTitle>
          <DialogContent>
            <Box sx={{ pt: 1 }}>
              <GitHubGrantForm
                github={github}
                githubError={githubError}
                current={managing.grant}
                readOnlyReason={connection.read_only_reason}
                busy={busy}
                onCancel={() => setManaging(null)}
                onSave={grantGitHub(managing.agentId)}
              />
            </Box>
          </DialogContent>
        </Dialog>
      )}
    </Stack>
  );
}
