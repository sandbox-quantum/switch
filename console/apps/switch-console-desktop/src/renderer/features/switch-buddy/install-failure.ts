import type { AgentInstallError } from '@shared/core/providers/agent-payload';
import { installOutputSummary } from './install-output-summary';

/**
 * What to tell someone whose install needed a program this computer lacks:
 * what it is, and how to get it, rather than the shell's "check the spelling".
 */
export function missingPrerequisite(name: string, command: string): string {
  switch (command.toLowerCase()) {
    case 'npm':
    case 'npx':
    case 'node':
      return `Installing ${name} needs Node.js, which isn’t installed on this computer. Install Node.js (nodejs.org), restart Switch Console, then press Install ${name} again.`;
    case 'winget':
      return `Installing ${name} needs winget, which isn’t available on this computer (Windows Server 2022 and older don’t have it, and Windows 11 only sets it up after your first sign-in). Install ${name} yourself, then press Check again.`;
    case 'curl':
      return `Installing ${name} needs curl, which isn’t on this computer. Install curl, or install ${name} yourself, then press Check again.`;
    default:
      return `Installing ${name} needs ${command}, which isn’t on this computer. Install it, or install ${name} yourself, then press Check again.`;
  }
}

/** What the card says when installing a provider's CLI failed, by why. */
export function installFailure(name: string, error: AgentInstallError): string {
  switch (error.type) {
    case 'not-detected-after-install':
      return `${name} was installed, but this computer can’t find it yet. Open a new terminal and check it runs, then press Check again.`;
    case 'no-install-command':
    case 'unknown-dependency':
      return `Switch Console can’t install ${name} on this computer. Install it yourself, then press Check again.`;
    case 'command-failed': {
      if (error.missingCommand) return missingPrerequisite(name, error.missingCommand);
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
