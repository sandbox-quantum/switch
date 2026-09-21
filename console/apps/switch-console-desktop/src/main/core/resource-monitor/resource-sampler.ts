import os from 'node:os';
import { app } from 'electron';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { resourceSnapshotChannel } from '@shared/events/resourceEvents';
import type {
  ResourceAppProcess,
  ResourceAppUsage,
  ResourceSnapshot,
} from '@shared/resource-monitor';
const SAMPLE_INTERVAL_MS = 1500;
export async function sampleOnce(): Promise<ResourceSnapshot> {
  const { usage, processes } = sampleAppUsage();
  return {
    timestamp: Date.now(),
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    app: usage,
    appProcesses: processes,
  };
}

/**
 * Sum memory + CPU across all Electron processes (main, renderer, GPU, utility)
 * and capture each row individually. `workingSetSize` is reported in KiB;
 * `percentCPUUsage` is % of one core.
 */
function sampleAppUsage(): { usage: ResourceAppUsage; processes: ResourceAppProcess[] } {
  try {
    const metrics = app.getAppMetrics();
    let memoryBytes = 0;
    let cpuPercent = 0;
    const processes: ResourceAppProcess[] = [];
    for (const m of metrics) {
      const memBytes = m.memory.workingSetSize * 1024;
      memoryBytes += memBytes;
      cpuPercent += m.cpu.percentCPUUsage;
      processes.push({
        pid: m.pid,
        type: m.type,
        name: m.name ?? m.serviceName,
        cpu: m.cpu.percentCPUUsage,
        memory: memBytes,
      });
    }
    return { usage: { memoryBytes, cpuPercent }, processes };
  } catch (err) {
    log.warn('resource-sampler: app metrics failed', err);
    return { usage: { memoryBytes: 0, cpuPercent: 0 }, processes: [] };
  }
}

let timer: NodeJS.Timeout | null = null;
const openSubscriptions = new Set<string>();
const latestSequenceByClient = new Map<string, number>();

export function startResourceSampler(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const snap = await sampleOnce();
      events.emit(resourceSnapshotChannel, snap);
    } catch (err) {
      log.warn('resource-sampler: sample failed', err);
    }
  };
  timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
  void tick();
}

export function stopResourceSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function setResourceMonitorOpen(
  clientId: string,
  subscriptionId: string,
  open: boolean,
  sequence: number
): void {
  const latestSequence = latestSequenceByClient.get(clientId) ?? 0;
  if (sequence <= latestSequence) return;
  latestSequenceByClient.set(clientId, sequence);
  if (open) {
    openSubscriptions.add(subscriptionId);
  } else {
    openSubscriptions.delete(subscriptionId);
    latestSequenceByClient.delete(clientId);
  }
  reconcileResourceSampler();
}

export function reconcileResourceSampler(): void {
  if (openSubscriptions.size > 0) startResourceSampler();
  else stopResourceSampler();
}
