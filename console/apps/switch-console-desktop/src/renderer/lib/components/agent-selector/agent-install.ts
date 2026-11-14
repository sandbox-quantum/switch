import type { AgentInstallError, AgentUpdateError } from '@shared/core/providers/agent-payload';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export type AgentInstallActionState = {
  render: boolean;
  disabled: boolean;
  installing: boolean;
  label: string;
};

export function getAgentInstallErrorMessage(error: AgentInstallError): string {
  switch (error.type) {
    case 'permission-denied':
      return error.message;
    case 'command-failed':
      return error.output ? `${error.message} ${error.output}` : error.message;
    case 'process-open-failed':
      return error.message;
    case 'unknown-dependency':
      return `Unknown dependency: ${error.id}`;
    case 'no-install-command':
      return `No install command is available for ${error.id}.`;
    case 'not-detected-after-install':
      return 'The agent was not detected after installation.';
  }
}

export function getAgentInstallActionState({
  agentId,
  agentName,
  canInstall,
  isInstalled,
  isInstalling,
}: {
  agentId: AgentProviderId;
  agentName?: string;
  canInstall: boolean;
  isInstalled: boolean;
  isInstalling: boolean;
}): AgentInstallActionState {
  return {
    render: canInstall && !isInstalled,
    disabled: isInstalling,
    installing: isInstalling,
    label: `Install ${agentName ?? getProvider(agentId)?.name ?? agentId}`,
  };
}

export type AgentUpdateActionState = {
  render: boolean;
  disabled: boolean;
  updating: boolean;
  label: string;
  versionLabel: string | null;
};

export function getAgentUpdateErrorMessage(error: AgentUpdateError): string {
  switch (error.type) {
    case 'permission-denied':
      return error.message;
    case 'command-failed':
      return error.output ? `${error.message} ${error.output}` : error.message;
    case 'process-open-failed':
      return error.message;
    case 'unknown-dependency':
      return `Unknown dependency: ${error.id}`;
    case 'no-update-strategy':
      return `No update strategy is available for ${error.id}.`;
    case 'not-detected-after-update':
      return 'The agent was not detected after update.';
    case 'line-migration-blocked':
      return error.message;
    case 'line-migration-failed':
      return `Installing the new version failed, so ${error.restoredVersion} was put back and keeps working. ${commandFailureText(error.cause)}`;
    case 'line-migration-unrestored':
      return `The upgrade failed, and so did putting ${error.previousVersion} back, so it is not installed now. Agents that use it can't start until one of these succeeds in a terminal: ${error.installCommand}, or to go back: ${error.restoreCommand}. ${commandFailureText(error.cause)}`;
  }
}

/**
 * The cause of a failed upgrade, short enough for a toast. A package manager's
 * output runs to dozens of lines of stack and warnings; its error code, or else
 * its last line, says what went wrong.
 */
export function commandFailureText(
  error: Extract<AgentUpdateError, { type: 'line-migration-failed' }>['cause']
): string {
  if (error.type !== 'command-failed' || !error.output) return error.message;
  const lines = error.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const code = lines.find((line) => /^npm error code \S+$/.test(line));
  const detail = code ?? lines.at(-1) ?? '';
  return detail.length > 160 ? `${detail.slice(0, 159)}…` : detail;
}

export function getAgentUpdateActionState({
  updateAvailable,
  updateStrategyKind,
  version,
  latestVersion,
  isUpdating,
}: {
  updateAvailable: boolean;
  updateStrategyKind: string;
  version: string | null;
  latestVersion: string | null;
  isUpdating: boolean;
}): AgentUpdateActionState {
  const canUpdate =
    updateAvailable && updateStrategyKind !== 'auto' && updateStrategyKind !== 'none';
  const versionLabel = version && latestVersion ? `v${version} → v${latestVersion}` : null;

  return {
    render: canUpdate,
    disabled: isUpdating,
    updating: isUpdating,
    label: isUpdating ? 'Updating...' : 'Update',
    versionLabel,
  };
}
