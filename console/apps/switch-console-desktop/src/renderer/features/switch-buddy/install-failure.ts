import type { AgentInstallError } from '@shared/core/providers/agent-payload';
import { installOutputSummary } from './install-output-summary';

/** What the card says when installing a provider's CLI failed, by why. */
export function installFailure(name: string, error: AgentInstallError): string {
  switch (error.type) {
    case 'not-detected-after-install':
      return `${name} was installed, but this computer can’t find it yet. Open a new terminal and check it runs, then press Check again.`;
    case 'no-install-command':
    case 'unknown-dependency':
      return `Switch Console can’t install ${name} on this computer. Install it yourself, then press Check again.`;
    case 'command-failed': {
      const last = installOutputSummary(error.output);
      return last
        ? `Installing ${name} failed: ${error.message} Output: ${last}`
        : `Installing ${name} failed: ${error.message}`;
    }
    case 'permission-denied':
    case 'process-open-failed':
      return `Installing ${name} failed: ${error.message}`;
  }
}
