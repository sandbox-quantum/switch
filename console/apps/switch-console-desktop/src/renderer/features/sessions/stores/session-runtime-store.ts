import type { ILifecycle } from '@switch-console/shared';
import { LifecycleScriptsStore } from './lifecycle-scripts';

export class SessionRuntimeStore implements ILifecycle {
  readonly path: string;
  readonly lifecycleScripts: LifecycleScriptsStore;

  constructor(locationId: string, path: string) {
    this.path = path;
    this.lifecycleScripts = new LifecycleScriptsStore(locationId);
  }

  activate(): void {}

  initialize(): void {
    this.activate();
  }

  dispose(): void {
    this.lifecycleScripts.dispose();
  }
}
