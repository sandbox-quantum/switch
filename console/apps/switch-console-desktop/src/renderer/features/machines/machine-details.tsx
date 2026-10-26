import { Plus } from 'lucide-react';
import { CopyButton } from '@renderer/features/admin/copy-button';
import {
  managedAgentLabel,
  managedAgentState,
} from '@renderer/features/managed-agents/managed-agent-state';
import type { ManagedTone } from '@renderer/features/switch-servers/managed-server-state';
import { MessageBox, SectionLabel } from '@renderer/features/switch-servers/server-page-ui';
import { agoLabel, sinceLabel } from '@renderer/features/switch-servers/server-times';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { formatBytes } from '@renderer/utils/formatBytes';
import { cn } from '@renderer/utils/utils';
import type { MachineDetail, ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { CollapsibleSection } from './collapsible-section';
import { MachineIcon, TONE_DOT, TonePill } from './machine-marks';
import { MachineProviders } from './machine-providers';
import {
  controllerRelease,
  lastContact,
  machineConnection,
  machineKindLabel,
  machineNotices,
  type MachineTone,
  platformLabel,
  resourceLabel,
  sessionsLabel,
} from './machine-state';

/** A notice's box, in the server page's hues. */
const NOTICE_TONE: Record<MachineTone, ManagedTone> = {
  ok: 'running',
  warning: 'attention',
  problem: 'failed',
  idle: 'stopped',
};

const STATE_TEXT: Record<MachineTone, string> = {
  ok: 'text-foreground',
  warning: 'text-foreground-warning',
  problem: 'text-foreground-error',
  idle: 'text-[var(--fg-dim)]',
};

const AGENT_TONE: Record<ReturnType<typeof managedAgentState>['tone'], MachineTone> = {
  ok: 'ok',
  busy: 'warning',
  idle: 'idle',
  problem: 'problem',
};

const PROCESS_TONE: Record<string, MachineTone> = {
  running: 'ok',
  starting: 'warning',
  pending: 'warning',
  restarting: 'warning',
  crashed: 'problem',
  failed: 'problem',
};

/**
 * One machine's page: what it is and whether it is connected, anything that
 * needs doing about it, what it last reported, and the agents on it. Built
 * from the local server's status page pieces, the other page about one
 * computer.
 */
export function MachineDetails({
  serverId,
  machine,
  placed,
}: {
  serverId: string;
  machine: MachineDetail;
  /** The managed agents placed on it. */
  placed: ManagedAgentView[];
}) {
  const connection = machineConnection(machine);
  const platform = platformLabel(machine.platform);
  const notices = machineNotices(machine);
  const removed = machine.state === 'revoked';
  const showAddAgentModal = useShowModal('addAgentModal');

  return (
    <div className="space-y-[18px]">
      <header className="flex items-center gap-3">
        <MachineIcon machine={machine} className="rounded-[10px] border-0 bg-[var(--fill)]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate font-mono text-[17px] font-semibold text-foreground">
              {machine.name}
            </h2>
            <TonePill tone={connection.tone} label={connection.label} title={connection.title} />
          </div>
          <p className="truncate text-[13px] text-[var(--fg-dim)]">
            {[machineKindLabel(machine), platform].filter(Boolean).join(' · ')}
          </p>
        </div>
        {!removed && (
          <Button
            size="sm"
            variant="outline"
            // The new agent form lists an offline machine but cannot place an agent on it.
            disabled={machine.state !== 'online'}
            title={
              machine.state === 'online' ? undefined : 'It can take a new agent once it is online.'
            }
            onClick={() => showAddAgentModal({ entryPoint: 'machine_page', machineId: machine.id })}
          >
            <Plus className="size-4" />
            New agent
          </Button>
        )}
      </header>

      {machine.description && (
        <p className="text-[13px] whitespace-pre-line text-foreground">{machine.description}</p>
      )}

      {notices.map((notice) => (
        <MessageBox key={notice.key} tone={NOTICE_TONE[notice.tone]} title={notice.title}>
          <p>{notice.body}</p>
        </MessageBox>
      ))}

      <DetailsSection machine={machine} />
      {!removed && <MachineProviders serverId={serverId} machine={machine} />}
      {!removed && <AgentsSection machine={machine} placed={placed} />}
    </div>
  );
}

/**
 * The agents on the machine: those placed on it, each opening its page, and
 * any others it reports running, which this person cannot open.
 */
function AgentsSection({
  machine,
  placed,
}: {
  machine: MachineDetail;
  placed: ManagedAgentView[];
}) {
  const { navigate } = useNavigate();
  const unlisted = machine.agents.filter(
    (report) => !placed.some((agent) => agent.agentId === report.agentId)
  );
  const count = placed.length + unlisted.length;
  return (
    <CollapsibleSection title={count === 0 ? 'Agents' : `Agents · ${count}`} defaultOpen>
      <div className="mt-1">
        {count === 0 && (
          <p className="py-[9px] text-[13px] text-[var(--fg-dim)]">No agents placed on it.</p>
        )}
        {placed.map((agent) => {
          const label = managedAgentLabel(agent);
          const state = managedAgentState(agent);
          const tone = AGENT_TONE[state.tone];
          const sessions =
            machine.agents.find((report) => report.agentId === agent.agentId)?.activeSessions ?? 0;
          return (
            <button
              key={agent.agentId}
              type="button"
              onClick={() =>
                navigate('managedAgent', {
                  serverId: agent.serverId,
                  agentId: agent.agentId,
                  name: label,
                })
              }
              className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-2.5 rounded-md border-b-[0.5px] border-[var(--hair-soft)] px-2 py-[7px] text-left text-[13px] transition-colors hover:bg-[var(--sel-soft)]"
            >
              <AgentAvatar
                name={label}
                iconUrl={agent.iconUrl}
                serverId={agent.serverId}
                size={20}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
              <span className="shrink-0 text-[var(--fg-dim)]">
                {providerDisplayName(agent.definition.provider) ?? agent.definition.provider}
                {sessions > 0 && ` · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`}
              </span>
              <StateText tone={tone} label={state.label} title={state.detail ?? undefined} />
            </button>
          );
        })}
        {unlisted.map((report) => (
          <div
            key={report.agentId}
            className="flex items-center gap-2.5 border-b-[0.5px] border-[var(--hair-soft)] py-[7px] text-[13px]"
            title="Runs here, but is not one of the agents you can open."
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--fg-dim)]">
              {report.agentId}
            </span>
            <StateText
              tone={PROCESS_TONE[report.process] ?? 'idle'}
              label={report.process}
              title={[report.reason, report.detail].filter(Boolean).join(': ') || undefined}
            />
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

function StateText({ tone, label, title }: { tone: MachineTone; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('flex w-24 shrink-0 items-center justify-end gap-1.5', STATE_TEXT[tone])}
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * What the machine last reported about itself, and when it was added and last
 * heard from: the short facts in a grid, then its workspaces folder, the one
 * value too long for one.
 */
function DetailsSection({ machine }: { machine: MachineDetail }) {
  const now = new Date();
  const release = controllerRelease(machine);
  const contact = lastContact(machine, now);
  const resources = machine.resources;
  const memory = resources
    ? resourceLabel(resources.memFreeBytes, resources.memTotalBytes, formatBytes)
    : null;
  const disk = resources
    ? resourceLabel(resources.diskFreeBytes, resources.diskTotalBytes, formatBytes)
    : null;
  const removed = machine.state === 'revoked';

  return (
    <>
      {/* Label above value, so each sits next to its own: these values are
        short, and across a full-width row the eye loses which is which. */}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 gap-y-4">
        <Fact label="Controller">
          <span title={release.title}>
            {machine.version ?? 'Not reported'}
            {release.badge
              ? ` · ${release.badge.label.toLowerCase()}`
              : machine.release?.current
                ? ' · up to date'
                : ''}
          </span>
        </Fact>
        {removed ? (
          machine.revokedAt && <Fact label="Removed">{sinceLabel(machine.revokedAt, now)}</Fact>
        ) : machine.state === 'online' && machine.connection ? (
          <Fact label="Connected since">{sinceLabel(machine.connection.connectedAt, now)}</Fact>
        ) : (
          <Fact label="Last seen">{contact ? agoLabel(contact, now) : 'Never'}</Fact>
        )}
        {!removed && resources && (
          <>
            <Fact label="Sessions running">{sessionsLabel(resources)}</Fact>
            {memory && <Fact label="Memory">{memory}</Fact>}
            {disk && <Fact label="Disk">{disk}</Fact>}
          </>
        )}
        {machine.createdAt && <Fact label="Added">{sinceLabel(machine.createdAt, now)}</Fact>}
      </dl>
      {machine.workspacesDir && (
        <section>
          <SectionLabel>Workspaces folder</SectionLabel>
          <div className="mt-1 flex items-start gap-1">
            <code className="min-w-0 pt-px font-[Menlo,ui-monospace,monospace] text-[11.5px] break-all text-foreground">
              {machine.workspacesDir}
            </code>
            <CopyButton value={machine.workspacesDir} />
          </div>
        </section>
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-[var(--fg-dim)]">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] text-foreground">{children}</dd>
    </div>
  );
}
