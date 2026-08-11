import { getLocalTerminalShellAvailability } from '@main/core/terminal-shell/resolver';

export async function getTerminalShellAvailability(_target?: { kind: 'local' }) {
  return await getLocalTerminalShellAvailability();
}
