import type { FileSystemProvider } from '@main/core/fs/types';
import type { LocationSettingsProvider } from '@main/core/locations/settings/provider';
import type { LifecycleScriptService } from './lifecycle-service';

/**
 * The live execution environment for a location: its filesystem, settings and
 * lifecycle scripts, shared by every session running there. Acquired/released
 * per session through the location runtime registry (ref-counted, one runtime
 * per location id).
 */
export interface LocationRuntime {
  readonly id: string;
  readonly path: string;
  readonly fs: FileSystemProvider;
  readonly settings: LocationSettingsProvider;
  readonly lifecycleService: LifecycleScriptService;
  dispose?(): void | Promise<void>;
}
