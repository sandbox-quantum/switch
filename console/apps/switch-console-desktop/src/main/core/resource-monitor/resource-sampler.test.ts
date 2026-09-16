import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  app: {
    getAppMetrics: () => [
      { pid: 1, type: 'Browser', memory: { workingSetSize: 100 }, cpu: { percentCPUUsage: 12 } },
      { pid: 2, type: 'Tab', memory: { workingSetSize: 200 }, cpu: { percentCPUUsage: 4 } },
    ],
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { sampleOnce } from './resource-sampler';
it('reports application process usage in bytes', async () => {
  const snapshot = await sampleOnce();
  expect(snapshot.app).toEqual({ memoryBytes: 300 * 1024, cpuPercent: 16 });
  expect(snapshot.appProcesses).toHaveLength(2);
});
