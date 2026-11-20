import type {
  AgentInstallError,
  AgentUninstallError,
  AgentUpdateError,
} from '@shared/core/providers/agent-payload';
import { installOutputSummary } from './install-output-summary';

/**
 * Why installing, updating or uninstalling a provider's CLI failed, in a line
 * a toast can carry: the command's own words where it printed any (a full
 * disk, a missing npm), so a failure is not left as just "failed".
 */
export function cliActionFailure(
  error: AgentInstallError | AgentUpdateError | AgentUninstallError
): string {
  switch (error.type) {
    case 'command-failed':
    case 'permission-denied': {
      const last = installOutputSummary(error.output);
      return last ? `${error.message} ${last}` : error.message;
    }
    case 'process-open-failed':
      return error.message;
    case 'not-detected-after-install':
    case 'not-detected-after-update':
      return 'It ran, but this computer can’t find the CLI afterwards. Check it runs in a new terminal, then recheck.';
    case 'no-install-command':
      return 'There is no install command for this computer. Install it yourself, then recheck.';
    case 'no-update-strategy':
      return 'This installation can’t be updated from Switch Console.';
    case 'no-uninstall-strategy':
    case 'no-uninstall-command':
      return 'This installation can’t be uninstalled from Switch Console. Remove it the way it was installed.';
    case 'uninstall-target-not-found':
      return `${error.package} isn’t installed through ${error.method}, so there was nothing to remove that way.`;
    case 'unknown-dependency':
      return 'Switch Console doesn’t know this provider.';
  }
}
