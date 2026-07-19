import type { Terminal } from '@shared/core/terminals/terminals';

export type LifecycleScriptSpawnRequest = {
  terminal: Terminal;
  command?: string;
  shellSetup?: string;
  initialSize?: { cols: number; rows: number };
  respawnOnExit?: boolean;
  preserveBufferOnExit?: boolean;
  watchDevServer?: boolean;
};

/**
 * Spawns lifecycle-script PTYs (setup/run/teardown) for a location. One
 * instance per location, owned by its LifecycleScriptService.
 */
export interface TerminalProvider {
  readonly kind: 'local' | 'ssh';
  spawnLifecycleScript(request: LifecycleScriptSpawnRequest): Promise<void>;
  destroyAll(): Promise<void>;
}
