import { ChevronDown, CircleAlert, Laptop, Server } from 'lucide-react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { machineProblem, machineTone, managedAgentState } from './managed-agent-state';

const DOT: Record<ReturnType<typeof machineTone>, string> = {
  ok: 'bg-green-500',
  problem: 'bg-red-500',
  idle: 'bg-foreground-muted',
};

/**
 * The machine a managed agent runs on, as a pill beside its provider, opening
 * onto a card: which machine, whether it is answering, what is wrong when
 * something is, and how the agent and the machine's providers are doing.
 */
export function ManagedMachinePill({
  agent,
  machines,
}: {
  agent: ManagedAgentView;
  machines: { data: OwnedMachine[] | null | undefined; error: unknown };
}) {
  const machine = machines.data?.find((candidate) => candidate.id === agent.machine?.id) ?? null;
  const tone = machineTone(agent, machine);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-background-tertiary px-2 text-[11px] text-foreground-muted hover:text-foreground"
          >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} />
            {agent.machine ? `on ${agent.machine.name}` : 'on no machine'}
            <ChevronDown className="size-3" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-80 gap-3">
        <MachineCard
          agent={agent}
          machine={machine}
          machinesLoading={machines.data === undefined && !machines.error}
          machinesError={machines.error}
        />
      </PopoverContent>
    </Popover>
  );
}

function MachineCard({
  agent,
  machine,
  machinesLoading,
  machinesError,
}: {
  agent: ManagedAgentView;
  machine: OwnedMachine | null;
  machinesLoading: boolean;
  machinesError: unknown;
}) {
  const problem = machineProblem(agent, machine);
  const state = managedAgentState(agent);
  const Icon = machine?.local?.kind === 'this-computer' ? Laptop : Server;
  const subtitle =
    machine?.local?.kind === 'this-computer'
      ? 'This computer'
      : machine?.local?.kind === 'ssh-host'
        ? `SSH host · ${machine.local.sshHost}`
        : (agent.machine?.kind ?? null);
  const readyProviders = machine?.providers.filter((entry) => entry.ready).length ?? 0;
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <Icon className="size-4 text-foreground-muted" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono font-semibold">
            {agent.machine?.name ?? 'No machine'}
          </span>
          {subtitle && <span className="text-xs text-foreground-muted">{subtitle}</span>}
        </div>
        {agent.machine && <MachineStatePill state={agent.machine.state} />}
      </div>
      {problem && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md bg-background-error px-3 py-2 text-foreground-error"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{problem}</span>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-foreground-muted">Agent</dt>
        <dd className="min-w-0 truncate">{state.label}</dd>
        <dt className="text-foreground-muted">Providers</dt>
        <dd className="min-w-0">
          {machinesError
            ? failureText(machinesError, 'Your machines could not be listed.')
            : machinesLoading
              ? 'Loading…'
              : !machine
                ? 'Not listed among your machines'
                : machine.providers.length === 0
                  ? 'Not reported yet'
                  : `${readyProviders} of ${machine.providers.length} providers ready`}
        </dd>
      </dl>
    </>
  );
}

function MachineStatePill({ state }: { state: 'online' | 'offline' | 'unknown' | 'revoked' }) {
  if (state === 'revoked')
    return <span className="shrink-0 text-xs text-foreground-muted">Removed</span>;
  const online = state === 'online';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs',
        online
          ? 'bg-background-success text-foreground-success'
          : 'bg-background-error text-foreground-error'
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', online ? 'bg-green-500' : 'bg-red-500')}
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}
