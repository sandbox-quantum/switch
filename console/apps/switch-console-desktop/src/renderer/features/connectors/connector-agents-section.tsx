import { ExternalLink, Plus, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { localAgentTabStore } from '@renderer/features/locations/stores/local-agent-tabs';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { agentProviderLabelFor } from '@renderer/lib/components/agent-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/lib/ui/input-group';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type {
  ConnectionAgent,
  ConnectionCatalogEntry,
} from '@shared/core/switch-servers/connection-catalog';
import { agentLinkFor, openAgentConnections } from './agent-links';
import {
  useConnectionAgents,
  useGitHubConnection,
  useReloadConnectors,
} from './connectors-queries';
import { NO_REPOSITORIES_NOTE } from './github-access';
import { GitHubAddAgentChoice } from './github-add-agent-choice';
import {
  type GitHubGrantChoice,
  connectedGitHub,
  emptyGitHubGrant,
  githubGrantResources,
} from './github-grant';
import {
  OPEN_AGENT_NOTE,
  addAgentIntro,
  addableAgents,
  agentsSummary,
  agentsUnlistedText,
  noAgentsText,
  offersAddAgent,
} from './grant-agents';

/**
 * The agents using the connector, drawn as a room's participants are: a
 * heading with the count, a card per agent, and an "Add agent" that opens a
 * search of the person's other agents under the cards. Adding one turns the
 * service on for it there and then; the cross on a card turns it off again.
 * A card opens the agent's Connections; an agent from another Console has
 * no page here, so its card is plain.
 */
export const ConnectorAgentsSection = observer(function ConnectorAgentsSection({
  serverId,
  workspaceId,
  connection,
  connected,
  adding,
  onAddingChange,
  notice,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  /** The person has a usable connection, so agents can be added. */
  connected: boolean;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  /** What connecting left to say, shown above the search while it is open. */
  notice: string | null;
}) {
  const name = connection.name;
  const agents = useConnectionAgents(workspaceId, connection.slug);
  const remote = useWorkspaceAgents(workspaceId);
  const iconFor = (agentId: string) =>
    remote.data?.find((agent) => agent.id === agentId)?.iconUrl ?? null;
  const usedBy = agents.data?.filter((agent) => agent.granted) ?? [];
  const { navigate } = useNavigate();
  const managed = useManagedAgents(serverId);
  const local = agentsStore.agentsInWorkspace(workspaceId);
  const canAdd = connected && offersAddAgent(connection) && agents.data != null;
  const reload = useReloadConnectors(workspaceId);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{ error: string | null; warning: string | null }>({
    error: null,
    warning: null,
  });
  async function remove(agent: ConnectionAgent) {
    setRemovingId(agent.agent_id);
    setRemoval({ error: null, warning: null });
    try {
      const warning = await rpc.workspaces.removeServiceGrant({
        workspaceId,
        agentId: agent.agent_id,
        service: connection.slug,
      });
      setRemoval({ error: null, warning });
      await reload();
    } catch (cause) {
      setRemoval({
        error: failureText(cause, `Could not turn ${name} off for ${agent.name}.`),
        warning: null,
      });
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Agents</h2>
          {agents.data && (
            <span className="text-xs text-foreground-muted">{agentsSummary(usedBy.length)}</span>
          )}
        </div>
        {canAdd && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={adding}
            onClick={() => onAddingChange(!adding)}
          >
            <Plus className="size-3.5" />
            Add agent
          </Button>
        )}
      </div>

      {agents.isPending && (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> Loading your agents…
        </p>
      )}
      {agents.isError && (
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'Could not load which of your agents use it.')}
        </p>
      )}
      {agents.data === null && (
        <p className="text-sm text-foreground-muted">{agentsUnlistedText(name)}</p>
      )}
      {agents.data && agents.data.length === 0 && (
        <p className="text-sm text-foreground-muted">{noAgentsText(name)}</p>
      )}
      {agents.data && agents.data.length > 0 && usedBy.length === 0 && (
        <p className="text-sm text-foreground-muted">None of your agents use {name} yet.</p>
      )}
      {usedBy.length > 0 && (
        <div role="list" aria-label="Agents" className="grid grid-cols-2 gap-2.5">
          {usedBy.map((agent) => {
            const link = agentLinkFor(agent.agent_id, local, managed.data);
            const body = (
              <>
                <span className="flex size-7 shrink-0 items-center justify-center">
                  <AgentAvatar
                    name={agent.name}
                    iconUrl={iconFor(agent.agent_id)}
                    serverId={serverId}
                    size={26}
                  />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                  <span className="truncate text-xs text-foreground-muted">
                    {agentProviderLabelFor(agent.agent_id, workspaceId)}
                  </span>
                </span>
              </>
            );
            return (
              <div
                key={agent.agent_id}
                role="listitem"
                title={link.kind === 'elsewhere' ? link.title : undefined}
                className={cn(
                  'group relative flex items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] py-3 pr-9 pl-3.5 transition-colors',
                  link.kind !== 'elsewhere' && 'hover:bg-[var(--fill)]'
                )}
              >
                {link.kind === 'elsewhere' ? (
                  body
                ) : (
                  <button
                    type="button"
                    title={`Open ${agent.name}'s Connectors`}
                    onClick={() => openAgentConnections(link, navigate, localAgentTabStore)}
                    className="focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
                  >
                    {/* Stretched over the card, so the whole card opens the agent while
                        the cross beside it keeps its own target. */}
                    <span aria-hidden className="absolute inset-0 rounded-[10px]" />
                    {body}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Turn ${name} off for ${agent.name}`}
                  title={`Turn ${name} off for ${agent.name}`}
                  disabled={removingId !== null}
                  onClick={() => void remove(agent)}
                  className="absolute top-1.5 right-1.5 z-10 flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--fill-2)] hover:text-foreground focus-visible:opacity-100 disabled:cursor-wait"
                >
                  {removingId === agent.agent_id ? <Spinner /> : <X className="size-3.5" />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {removal.error && (
        <p role="alert" className="text-xs text-destructive">
          Not turned off — {removal.error}
        </p>
      )}
      {removal.warning && (
        <p role="status" className="text-xs text-foreground-muted">
          {removal.warning}
        </p>
      )}

      {canAdd && adding && agents.data && (
        <AddAgentPanel
          serverId={serverId}
          workspaceId={workspaceId}
          connection={connection}
          agents={agents.data}
          iconFor={iconFor}
          notice={notice}
        />
      )}
      {!offersAddAgent(connection) && (
        <p className="text-xs text-foreground-muted">
          Turn it on for an agent from the agent&apos;s Connections.
        </p>
      )}
      {connection.slug === 'github' && usedBy.length > 0 && (
        <p className="text-xs text-foreground-muted">
          Each agent has its own repositories and access, changed from its Connections.
        </p>
      )}
    </section>
  );
});

/**
 * Search the person's agents and turn the service on for one. An agent others
 * can address is offered with a note in place of what runs it, since whoever
 * addresses it would have it act as the person. For GitHub, the repositories
 * and access every added agent gets are chosen above the search, and no
 * agent can be added until some are; each agent's own choice is on its
 * Connections.
 */
const AddAgentPanel = observer(function AddAgentPanel({
  serverId,
  workspaceId,
  connection,
  agents,
  iconFor,
  notice,
}: {
  serverId: string;
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  agents: ConnectionAgent[];
  iconFor: (agentId: string) => string | null;
  notice: string | null;
}) {
  const name = connection.name;
  const isGitHub = connection.slug === 'github';
  const reload = useReloadConnectors(workspaceId);
  const github = useGitHubConnection(workspaceId, isGitHub);
  const [choice, setChoice] = useState<GitHubGrantChoice | null>(null);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    if (isGitHub && choice === null && github.data) setChoice(emptyGitHubGrant(github.data));
  }, [isGitHub, choice, github.data]);
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const candidates = addableAgents(agents, filter);
  const query = filter.trim();
  const reach = connectedGitHub(github.data);
  const resources = isGitHub ? (choice ? githubGrantResources(choice) : null) : {};
  const noRepositories = reach !== null && reach.installations.length === 0;

  async function add(agentId: string) {
    if (resources === null) return;
    setBusyId(agentId);
    setError(null);
    try {
      const result = await rpc.workspaces.setServiceGrant({
        workspaceId,
        agentId,
        service: connection.slug,
        access: isGitHub && choice ? choice.access : null,
        resources,
      });
      setWarning(result);
      await reload();
    } catch (cause) {
      setError(failureText(cause, `Could not turn ${name} on for the agent.`));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      {notice && (
        <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
          {notice}
        </p>
      )}
      {isGitHub && reach && !noRepositories && choice ? (
        <GitHubAddAgentChoice
          github={reach}
          choice={choice}
          readOnlyReason={connection.read_only_reason}
          onChange={setChoice}
          choosing={choosing}
          onChoosingChange={setChoosing}
        />
      ) : (
        <p className="text-sm text-foreground-muted">{addAgentIntro(connection)}</p>
      )}
      {isGitHub && github.isError && (
        <p role="alert" className="text-xs text-destructive">
          {failureText(github.error, 'Could not load your GitHub repositories.')}
        </p>
      )}
      {isGitHub && noRepositories && (
        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          <p className="flex-1 text-sm text-foreground-muted">{NO_REPOSITORIES_NOTE}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void rpc.switchServers.openGitHubInstallation(serverId)}
          >
            Choose repositories <ExternalLink className="size-3.5" />
          </Button>
        </div>
      )}
      <InputGroup>
        <InputGroupAddon>
          <Search className="size-3.5 text-foreground-muted" />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          placeholder="Search your agents…"
          aria-label="Search agents to add"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter !== '' && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear the search"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {error !== null && <p className="text-xs text-destructive">Not added — {error}</p>}
      {warning !== null && (
        <p role="status" className="text-xs text-foreground-muted">
          {warning}
        </p>
      )}

      {candidates.length === 0 ? (
        <p className="px-1 py-2 text-sm text-foreground-muted">
          {query === ''
            ? `Every one of your agents already uses ${name}.`
            : `No agent here matches “${query}”.`}
        </p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {candidates.map((agent) => {
            const busy = busyId === agent.agent_id;
            return (
              <button
                key={agent.agent_id}
                type="button"
                disabled={busyId !== null || resources === null}
                onClick={() => void add(agent.agent_id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 bg-background px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--fill)]',
                  busyId !== null && 'cursor-wait'
                )}
              >
                <AgentAvatar
                  name={agent.name}
                  iconUrl={iconFor(agent.agent_id)}
                  serverId={serverId}
                  size={22}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {agent.name}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    agent.addressing_open
                      ? 'text-amber-600 dark:text-amber-500'
                      : 'text-foreground-muted'
                  )}
                >
                  {agent.addressing_open
                    ? OPEN_AGENT_NOTE
                    : agentProviderLabelFor(agent.agent_id, workspaceId)}
                </span>
                <span className="shrink-0 text-xs font-medium text-foreground">
                  {busy ? 'Adding…' : 'Add'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
