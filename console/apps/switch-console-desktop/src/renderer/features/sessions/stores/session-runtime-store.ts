import type { ILifecycle } from '@switch-console/shared';

export class SessionRuntimeStore implements ILifecycle {
  readonly path: string;

  constructor(_locationId: string, path: string) {
    this.path = path;
  }

  activate(): void {}

  initialize(): void {
    this.activate();
  }

  dispose(): void {}
}
