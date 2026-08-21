import { createRPCController } from '@shared/lib/ipc/rpc';
import { trackFromRenderer, type RendererTelemetryRequest } from './renderer-events';

/**
 * The interface's one way to report something.
 *
 * Deliberately a single procedure taking a name and a bag of properties, rather
 * than one procedure per event: what may be reported is decided by the list in
 * `./renderer-events`, in the main process, and a shape that made each event its
 * own entry point would spread that decision across the surface it is meant to
 * constrain.
 *
 * It returns nothing and cannot fail from the caller's point of view — reporting
 * must never change what the app does, and a rejected request is a bug to fix in
 * the app rather than a condition for a screen to handle.
 */
export const telemetryController = createRPCController({
  track: async (request: RendererTelemetryRequest): Promise<void> => {
    trackFromRenderer(request);
  },
});
