import { computed, makeObservable, observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import { resourceSnapshotChannel } from '@shared/events/resourceEvents';
import type { ResourceSnapshot } from '@shared/resource-monitor';

export class ResourceMonitorStore {
  snapshot: ResourceSnapshot | null = null;
  private started = false;
  private offSnapshot: (() => void) | null = null;
  private clientId = crypto.randomUUID();
  private sequence = 0;
  private subscriptionId: string | null = null;

  constructor() {
    makeObservable(this, {
      snapshot: observable,
      totalCpuPercent: computed,
      totalMemoryBytes: computed,
      appMemoryBytes: computed,
    });
  }

  /**
   * Total CPU usage as a fraction of the whole machine (0 - 100+%).
   * pidusage reports each PID as % of one core; divide by core count to
   * normalize against total CPU capacity.
   */
  get totalCpuPercent(): number {
    const snap = this.snapshot;
    if (!snap || snap.cpuCount === 0) return 0;
    return (snap.app?.cpuPercent ?? 0) / snap.cpuCount;
  }

  get totalMemoryBytes(): number {
    return this.appMemoryBytes;
  }

  get appMemoryBytes(): number {
    return this.snapshot?.app?.memoryBytes ?? 0;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const subscriptionId = crypto.randomUUID();
    this.subscriptionId = subscriptionId;
    void rpc.resourceMonitor.setOpen(this.clientId, subscriptionId, true, ++this.sequence);
    this.offSnapshot = events.on(resourceSnapshotChannel, (snap) => {
      runInAction(() => {
        this.snapshot = snap;
      });
    });
    rpc.resourceMonitor
      .getSnapshot()
      .then((res) => {
        if (!res?.success || !res.data) return;
        runInAction(() => {
          this.applyFetchedSnapshot(res.data);
        });
      })
      .catch(() => {});
  }

  dispose(): void {
    if (!this.started) return;
    const subscriptionId = this.subscriptionId;
    this.offSnapshot?.();
    this.offSnapshot = null;
    this.started = false;
    this.subscriptionId = null;
    if (subscriptionId) {
      void rpc.resourceMonitor.setOpen(this.clientId, subscriptionId, false, ++this.sequence);
    }
  }

  async refresh(): Promise<void> {
    const res = await rpc.resourceMonitor.getSnapshot();
    if (!res?.success) return;
    runInAction(() => {
      this.applyFetchedSnapshot(res.data);
    });
  }

  private applyFetchedSnapshot(snap: ResourceSnapshot | null): void {
    if (snap && this.snapshot && this.snapshot.timestamp > snap.timestamp) return;
    this.snapshot = snap;
  }
}
