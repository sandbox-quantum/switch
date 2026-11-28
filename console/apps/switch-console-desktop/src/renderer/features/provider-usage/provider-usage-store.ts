import type { Result } from '@switch-console/shared';
import { makeObservable, observable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import type { ProviderUsageState } from '@shared/core/provider-usage/provider-usage';
import { providerUsageUpdatedChannel } from '@shared/events/providerUsageEvents';

interface UsageBridge {
  subscribe(listener: (state: ProviderUsageState) => void): () => void;
  getSnapshots(): Promise<Result<ProviderUsageState>>;
  setActive(active: boolean): Promise<Result<void>>;
  refresh(providerId?: string): Promise<Result<ProviderUsageState>>;
}

const EMPTY_STATE: ProviderUsageState = {
  revision: -1,
  installedProviderIds: [],
  refreshingProviderIds: [],
  snapshots: [],
};

export class ProviderUsageStore {
  state = EMPTY_STATE;
  error = false;
  private generation = 0;

  constructor(private readonly bridge: UsageBridge) {
    makeObservable(this, { state: observable.ref, error: observable });
  }

  mount(): () => void {
    const generation = ++this.generation;
    const unsubscribe = this.bridge.subscribe((state) => this.apply(generation, state));
    void this.initialize(generation);
    return () => {
      if (generation !== this.generation) return;
      ++this.generation;
      unsubscribe();
      runInAction(() => {
        this.state = EMPTY_STATE;
        this.error = false;
      });
      void this.bridge.setActive(false).catch(() => {});
    };
  }

  private async initialize(generation: number): Promise<void> {
    try {
      const active = await this.bridge.setActive(true);
      if (generation !== this.generation) return;
      const result = await this.bridge.getSnapshots();
      if (active.success && result.success) this.apply(generation, result.data);
      else this.fail(generation);
    } catch {
      this.fail(generation);
    }
  }

  async refresh(providerId?: string): Promise<void> {
    const generation = this.generation;
    try {
      const result = await this.bridge.refresh(providerId);
      if (result.success) this.apply(generation, result.data);
      else this.fail(generation);
    } catch {
      this.fail(generation);
    }
  }

  private apply(generation: number, state: ProviderUsageState): void {
    if (generation !== this.generation || state.revision < this.state.revision) return;
    runInAction(() => {
      this.state = state;
      this.error = false;
    });
  }

  private fail(generation: number): void {
    if (generation !== this.generation) return;
    runInAction(() => {
      this.error = true;
    });
  }
}

export function createProviderUsageStore(): ProviderUsageStore {
  return new ProviderUsageStore({
    subscribe: (listener) => events.on(providerUsageUpdatedChannel, listener),
    getSnapshots: () => rpc.providerUsage.getSnapshots(),
    setActive: (active) => rpc.providerUsage.setActive(active),
    refresh: (id) => rpc.providerUsage.refresh(id),
  });
}
