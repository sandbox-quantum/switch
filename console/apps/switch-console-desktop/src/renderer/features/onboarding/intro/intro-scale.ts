import { STAGE } from './timeline';

/**
 * The scale the intro's stage plays at: its own size wherever it fits, and
 * smaller only in a window smaller than it. It never reflows: the motion is
 * choreographed against exact geometry.
 */
export function introScale(available: { width: number; height: number }): number {
  return Math.min(1, available.width / STAGE.w, available.height / STAGE.h);
}
