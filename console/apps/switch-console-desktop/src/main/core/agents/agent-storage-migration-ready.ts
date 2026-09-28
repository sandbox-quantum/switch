/**
 * The boot-time agent storage migration, as something to wait on.
 *
 * The migration runs off the boot path, so a settings page or a launch can reach
 * an agent before its config file has been created. Those readers wait on this
 * before concluding a missing file is an error, rather than failing for an agent
 * the migration is about to fix.
 *
 * An agent the migration could not reach (its host was down) is remembered, so
 * the first reader to reach it later finishes the job instead of waiting for
 * the next boot.
 */
let ready: Promise<void> = Promise.resolve();
const unmigrated = new Set<string>();

export function setAgentStorageMigrationReady(migration: Promise<void>): void {
  ready = migration;
}

export function agentStorageMigrationReady(): Promise<void> {
  return ready;
}

export function markAgentUnmigrated(agentId: string): void {
  unmigrated.add(agentId);
}

export function markAgentMigrated(agentId: string): void {
  unmigrated.delete(agentId);
}

export function isAgentUnmigrated(agentId: string): boolean {
  return unmigrated.has(agentId);
}
