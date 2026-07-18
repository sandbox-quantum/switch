import { getSessionAgent } from '@renderer/features/sessions/stores/session-selectors';
import { appState } from '@renderer/lib/stores/app-state';
import { formatBytes } from '@renderer/utils/formatBytes';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { createLifecycleScriptTerminalId } from '@shared/core/terminals/terminals';
import type {
  ResourceAppProcess,
  ResourcePtyEntry,
  ResourceSnapshot,
} from '@shared/resource-monitor';

export type Entry = ResourcePtyEntry & {
  sessionName?: string;
  providerId?: AgentProviderId;
  displayTitle?: string;
};

export type SessionBucket = {
  scopeId: string;
  sessionName: string;
  entries: Entry[];
  cpuSum: number;
};

export type Group = {
  locationId: string;
  projectName: string;
  sessions: SessionBucket[];
  entryCount: number;
};

const UNKNOWN_PROJECT_ID = '__unknown__';

/**
 * Lifecycle-script PTYs are labelled by their terminal id (see
 * `createLifecycleScriptTerminalId`), which has no provider/conversation
 * metadata. Map those ids to friendly labels so they don't render as the
 * truncated "script-l…" leaf id.
 */
const LIFECYCLE_SCRIPT_LABELS: Record<string, string> = {
  [createLifecycleScriptTerminalId('setup')]: 'Setup script',
  [createLifecycleScriptTerminalId('run')]: 'Run script',
  [createLifecycleScriptTerminalId('teardown')]: 'Teardown script',
};

export function isLifecycleScriptEntry(entry: Pick<Entry, 'leafId'>): boolean {
  return entry.leafId in LIFECYCLE_SCRIPT_LABELS;
}

/** Single source of truth for an entry's display label. */
export function entryLabel(entry: Entry, agentNames?: Map<string, string>): string {
  return (
    LIFECYCLE_SCRIPT_LABELS[entry.leafId] ||
    entry.displayTitle ||
    (entry.providerId ? agentNames?.get(entry.providerId) : undefined) ||
    entry.providerId ||
    entry.leafId.slice(0, 8)
  );
}

export function formatReport(snapshot: ResourceSnapshot, groups: Group[]): string {
  const entryMem = snapshot.entries.reduce((n, e) => n + e.memory, 0);
  const entryCpu = snapshot.entries.reduce((n, e) => n + e.cpu, 0);
  const totalMem = snapshot.app.memoryBytes + entryMem;
  const totalCpuNorm =
    snapshot.cpuCount > 0 ? (snapshot.app.cpuPercent + entryCpu) / snapshot.cpuCount : 0;

  const lines: string[] = [];
  lines.push(`CPU ${totalCpuNorm.toFixed(1)}% Memory ${formatBytes(totalMem)}`);

  for (const proc of snapshot.appProcesses) {
    const label = appProcessLabel(proc.type, proc.name);
    const cpu = snapshot.cpuCount > 0 ? proc.cpu / snapshot.cpuCount : 0;
    lines.push(`${label} ${cpu.toFixed(1)}% ${formatBytes(proc.memory)} (pid=${proc.pid})`);
  }

  for (const g of groups) {
    for (const t of g.sessions) {
      for (const e of t.entries) {
        const path = `${g.projectName} / ${t.sessionName} / ${entryLabel(e)}`;
        const parts: string[] = [];
        if (e.pid !== undefined) parts.push(`pid=${e.pid}`);
        if (e.ppid !== undefined) parts.push(`ppid=${e.ppid}`);
        if (e.pid === undefined) parts.push('ssh');
        const suffix = parts.length > 0 ? ` (${parts.join(' ')})` : '';
        const cpu = snapshot.cpuCount > 0 ? e.cpu / snapshot.cpuCount : 0;
        lines.push(`${path} ${cpu.toFixed(1)}% ${formatBytes(e.memory)}${suffix}`);
      }
    }
  }

  return lines.join('\n');
}

export function appProcessLabel(type: string, name?: string): string {
  if (type === 'Browser') return 'Main';
  if (type === 'Tab') return 'Renderer';
  if (type === 'GPU') return 'GPU';
  if (type === 'Zygote') return 'Zygote';
  if (type === 'Sandbox helper') return 'Sandbox';
  if (type === 'Utility') return name ?? 'Utility';
  return name ?? type;
}

export function sortAppProcesses(processes: ResourceAppProcess[]): ResourceAppProcess[] {
  return [...processes].sort((a, b) => {
    const labelCompare = appProcessLabel(a.type, a.name).localeCompare(
      appProcessLabel(b.type, b.name)
    );
    if (labelCompare !== 0) return labelCompare;
    return a.pid - b.pid;
  });
}

export function buildGroups(entries: ResourcePtyEntry[]): Group[] {
  const projects = appState.locations.locations;
  const byProject = new Map<
    string,
    { projectName: string; sessions: Map<string, SessionBucket> }
  >();

  for (const entry of entries) {
    const projectStore = projects.get(entry.locationId);
    let sessionName = entry.scopeId;
    // The bucket key normally matches the entry's scopeId, but lifecycle
    // scripts are scoped by locationId while agents are scoped by sessionId.
    // Resolving both to the owning session id groups them under the same branch.
    let bucketKey = entry.scopeId;
    let providerId: AgentProviderId | undefined;
    let displayTitle: string | undefined;
    let projectName = 'Other';
    let projectKey = UNKNOWN_PROJECT_ID;

    if (projectStore) {
      projectKey = entry.locationId;
      projectName = projectStore.name ?? projectStore.data?.name ?? entry.locationId.slice(0, 8);
      const mounted = projectStore.mountedLocation;
      // Agent PTYs use the session id as scopeId; lifecycle-script PTYs use the
      // workspace id. Try the direct lookup first, then fall back to matching
      // a session by its locationId so scripts attach to their owning branch.
      let sessionId = entry.scopeId;
      let session = mounted?.sessionManager.sessions.get(entry.scopeId);
      if (!session && mounted) {
        for (const [id, candidate] of mounted.sessionManager.sessions) {
          if (candidate.locationId === entry.scopeId) {
            sessionId = id;
            session = candidate;
            break;
          }
        }
      }
      if (session) {
        bucketKey = sessionId;
        sessionName = session.displayName;
        const agent = entry.leafId === sessionId ? getSessionAgent(sessionId)?.agent : undefined;
        providerId = agent?.data.providerId;
        displayTitle = agent?.data.title;
      }
    }

    // Fall back to metadata supplied by the sampler (covers cases where the
    // owning project isn't mounted, so the conversation/terminal join above misses).
    providerId ??= entry.providerId;
    displayTitle ??= entry.title;

    const project = byProject.get(projectKey) ?? {
      projectName,
      sessions: new Map<string, SessionBucket>(),
    };
    const sessionBucket = project.sessions.get(bucketKey) ?? {
      scopeId: bucketKey,
      sessionName,
      entries: [],
      cpuSum: 0,
    };
    sessionBucket.entries.push({ ...entry, sessionName, providerId, displayTitle });
    sessionBucket.cpuSum += entry.cpu;
    project.sessions.set(bucketKey, sessionBucket);
    byProject.set(projectKey, project);
  }

  const groups: Group[] = Array.from(byProject.entries()).map(([locationId, p]) => {
    const sessions = Array.from(p.sessions.values());
    for (const t of sessions) {
      t.entries.sort((a, b) => {
        const labelCompare = entryLabel(a).localeCompare(entryLabel(b));
        if (labelCompare !== 0) return labelCompare;
        return a.sessionId.localeCompare(b.sessionId);
      });
    }
    sessions.sort(
      (a, b) => a.sessionName.localeCompare(b.sessionName) || a.scopeId.localeCompare(b.scopeId)
    );
    return {
      locationId,
      projectName: p.projectName,
      sessions,
      entryCount: sessions.reduce((n, t) => n + t.entries.length, 0),
    };
  });

  // Keep the "Other" bucket at the end so real projects render first.
  groups.sort((a, b) => {
    if (a.locationId === UNKNOWN_PROJECT_ID) return 1;
    if (b.locationId === UNKNOWN_PROJECT_ID) return -1;
    return a.projectName.localeCompare(b.projectName) || a.locationId.localeCompare(b.locationId);
  });

  return groups;
}
