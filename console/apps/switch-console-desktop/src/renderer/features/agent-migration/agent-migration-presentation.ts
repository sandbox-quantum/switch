import type {
  AgentMigrationState,
  MigrationOperation,
  MigrationTarget,
  MoveAllResult,
} from '@shared/core/agent-migration/agent-migration';

export type MigrationTone = 'neutral' | 'busy' | 'ok' | 'warn' | 'error';

/** The machine, said for a person. */
export function targetName(target: MigrationTarget | null): string {
  if (!target) return 'a managed machine';
  if (target.kind === 'this-computer')
    return target.machineName ? `this computer (${target.machineName})` : 'this computer';
  return target.machineName ? `${target.sshHost} (${target.machineName})` : target.sshHost;
}

/** What a move or a return in flight is doing now. */
export function operationLabel(operation: MigrationOperation): string {
  const moving = operation.kind === 'moving';
  switch (operation.stage) {
    case 'checking':
      return moving ? 'Checking it can move…' : 'Checking it can come back…';
    case 'waiting-for-turn':
      return `Waiting for the current turn to end (${operation.busySessions.length} session${operation.busySessions.length === 1 ? '' : 's'} working)…`;
    case 'adopting':
      return 'Placing it on the machine…';
    case 'stopping-console-watcher':
      return 'Stopping this Console’s watcher…';
    case 'preparing-machine':
      return 'Preparing the machine…';
    case 'releasing':
      return moving ? 'Starting it on the machine…' : 'Asking Switch to stop managing it…';
    case 'waiting-for-controller':
      return 'Waiting for the machine to stop it…';
    case 'restoring-console-watcher':
      return 'Starting this Console’s watcher…';
  }
}

export type MigrationSummary = { label: string; tone: MigrationTone; detail: string | null };

/** One line about where the agent runs, and how that is going. */
export function migrationSummary(state: AgentMigrationState): MigrationSummary {
  if (state.operation)
    return {
      label: state.operation.kind === 'moving' ? 'Moving…' : 'Coming back…',
      tone: 'busy',
      detail: operationLabel(state.operation),
    };
  if (state.runner === 'console')
    return { label: 'Run by this Console', tone: 'neutral', detail: null };
  const where = targetName(state.target);
  const managed = state.managed;
  if (!managed)
    return { label: 'Managed', tone: 'ok', detail: `Runs on ${where}, with its parent.` };
  if (managed.unreadable) return { label: 'Managed', tone: 'warn', detail: managed.unreadable };
  if (managed.machine.kind === 'stopped' && managed.desiredState !== 'stopped')
    return { label: 'Managed, not running', tone: 'warn', detail: managed.machine.reason };
  if (managed.machine.kind === 'unknown')
    return { label: 'Managed', tone: 'warn', detail: managed.machine.reason };
  if (managed.desiredState === 'stopped')
    return { label: 'Managed, stopped', tone: 'neutral', detail: `Placed on ${where}, stopped.` };
  const actual = managed.actual;
  if (!actual)
    return { label: 'Managed', tone: 'busy', detail: `Runs on ${where}; it has not reported yet.` };
  const reason = actual.reason ? ` (${actual.reason.replaceAll('_', ' ')})` : '';
  if (actual.process === 'failed' || actual.process === 'crashed')
    return {
      label: 'Managed, failed',
      tone: 'error',
      detail: `${where}: ${actual.process}${reason}${actual.detail ? ` — ${actual.detail}` : ''}`,
    };
  if (actual.process === 'running')
    return actual.attached
      ? { label: 'Managed', tone: 'ok', detail: `Runs on ${where}.` }
      : {
          label: 'Managed',
          tone: 'warn',
          detail: `Runs on ${where}, but its events are not reaching it yet.`,
        };
  return { label: 'Managed', tone: 'busy', detail: `${where}: ${actual.process}${reason}` };
}

export type MigrationAction = {
  kind: 'move' | 'return';
  label: string;
  /** Why it cannot run now, or null when it can. */
  disabledReason: string | null;
};

/** The one action offered for the agent: move it, or bring it back. Null for a subagent. */
export function migrationAction(state: AgentMigrationState): MigrationAction | null {
  if (state.movesWithParent) return null;
  const busy = state.operation ? 'Working…' : null;
  if (state.runner === 'managed')
    return { kind: 'return', label: 'Stop managing', disabledReason: busy ?? state.blocker };
  return { kind: 'move', label: 'Move to managed', disabledReason: busy ?? state.blocker };
}

/** What a "Move all" or "Bring all back" did, for a person. */
export function moveAllSummary(result: MoveAllResult, verb: 'Moved' | 'Brought back'): string[] {
  const lines: string[] = [];
  lines.push(
    result.moved.length
      ? `${verb} ${result.moved.map((agent) => agent.name).join(', ')}.`
      : `${verb} no agents.`
  );
  for (const agent of result.skipped) lines.push(`${agent.name} did not move: ${agent.reason}`);
  for (const agent of result.failed) lines.push(`${agent.name} failed: ${agent.message}`);
  return lines;
}
