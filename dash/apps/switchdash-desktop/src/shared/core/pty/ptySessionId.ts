/**
 * Deterministic PTY session IDs.
 *
 * Agent sessions use `<projectId>:<sessionId>` — the session IS the agent run
 * (one agent PTY per session). Terminal-scoped PTYs (lifecycle scripts) use
 * `<projectId>:<scopeId>:<leafId>` where scopeId is a workspace id and leafId
 * a terminal id.
 *
 * There is at most one active PTY per leaf entity. Using a deterministic ID
 * means the renderer can subscribe to ptyDataChannel BEFORE the PTY spawns —
 * no extra round-trip is needed to learn the session ID.
 */
export function makeAgentPtySessionId(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
}

export function makePtySessionId(projectId: string, scopeId: string, leafId: string): string {
  return `${projectId}:${scopeId}:${leafId}`;
}

export interface ParsedPtySessionId {
  projectId: string;
  scopeId: string;
  leafId: string;
}

export function parsePtySessionId(id: string): ParsedPtySessionId | null {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] && parts[1]) {
    // Agent PTY: the session id is both the scope and the leaf.
    return { projectId: parts[0], scopeId: parts[1], leafId: parts[1] };
  }
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { projectId: parts[0], scopeId: parts[1], leafId: parts[2] };
}
