import { formatBytes } from '@renderer/utils/formatBytes';
import type { ResourceAppProcess, ResourceSnapshot } from '@shared/resource-monitor';
export function formatReport(snapshot: ResourceSnapshot): string {
  return snapshot.appProcesses
    .map(
      (proc) =>
        `${appProcessLabel(proc.type, proc.name)} ${(snapshot.cpuCount ? proc.cpu / snapshot.cpuCount : 0).toFixed(1)}% ${formatBytes(proc.memory)} (pid=${proc.pid})`
    )
    .join('\n');
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
