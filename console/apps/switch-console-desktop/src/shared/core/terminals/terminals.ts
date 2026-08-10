import type { TerminalShellId } from './terminal-settings';

export type Terminal = {
  id: string;
  locationId: string;
  sessionId: string;
  shellId: TerminalShellId;
  name: string;
};

export type CreateTerminalParams = {
  id: string;
  locationId: string;
  sessionId: string;
  name: string;
  shell?: TerminalShellId;
  initialSize?: { cols: number; rows: number };
};

export function createLifecycleScriptTerminalId(type: 'setup' | 'run' | 'teardown') {
  return `script-lifecycle-${type}`;
}
