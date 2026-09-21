export interface ResourceAppUsage {
  memoryBytes: number;
  cpuPercent: number;
}

export type ResourceAppProcessType =
  | 'Browser'
  | 'Tab'
  | 'Utility'
  | 'Zygote'
  | 'Sandbox helper'
  | 'GPU'
  | 'Pepper Plugin'
  | 'Pepper Plugin Broker'
  | 'Unknown';

/**
 * Per-process breakdown of the Electron app (one entry per `app.getAppMetrics()`
 * row). Sums of `memory` / `cpu` across these match `ResourceAppUsage`.
 */
export interface ResourceAppProcess {
  pid: number;
  type: ResourceAppProcessType;
  name?: string;
  cpu: number;
  memory: number;
}

export interface ResourceSnapshot {
  timestamp: number;
  cpuCount: number;
  totalMemoryBytes: number;
  app: ResourceAppUsage;
  appProcesses: ResourceAppProcess[];
}
