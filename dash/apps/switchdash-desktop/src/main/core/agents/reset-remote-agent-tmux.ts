import { agentSidecarTmuxName } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { exactTmuxTarget, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { quoteShellArg } from '@main/utils/shellEscape';

/**
 * The tmux session names to kill when resetting an agent: one per agent session
 * id plus the agent's sidecar session. Deduplicated by name.
 */
export function resetTmuxTargets(sessionIds: string[], remoteRepoDir: string): string[] {
  return [
    ...new Set([...sessionIds.map(makeAgentTmuxSessionName), agentSidecarTmuxName(remoteRepoDir)]),
  ];
}

/**
 * A `sh -c` script that kills each named tmux session on the remote host, failing
 * loud. Each target is killed only if it exists (`has-session` guards the
 * `kill-session`), so an already-gone session — or a host with no tmux server at
 * all — is a no-op, while a real `kill-session` failure aborts the whole script
 * (`set -e`). Returns null when there is nothing to kill.
 */
export function buildKillTmuxScript(sessionNames: string[]): string | null {
  if (sessionNames.length === 0) return null;
  const lines = sessionNames.map((name) => {
    const target = quoteShellArg(exactTmuxTarget(name));
    return `if tmux has-session -t ${target} 2>/dev/null; then tmux kill-session -t ${target}; fi`;
  });
  return ['set -e', ...lines].join('\n');
}
