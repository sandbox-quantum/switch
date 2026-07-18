import { locationManager } from '@main/core/locations/location-manager';
import { getLocationById } from '@main/core/locations/store';
import { hydrateSession } from '@main/core/sessions/operations/hydrateSession';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { sessionService } from '@main/core/sessions/session-service';
import { log } from '@main/lib/logger';
import { switchRoomService } from './switch-room-service';

/**
 * Launch every session that was connected to a Switch room before the last
 * shutdown, so it receives and responds to room events without the user opening
 * its terminal. Replays the renderer's open sequence from the main process:
 * open the location → provision the session runtime → hydrate the session
 * (which spawns the PTY and, via the session-launch path, restarts the room
 * poller). Sessions whose row or location no longer exist are pruned.
 *
 * This deliberately spawns the agent process for each room-connected session at
 * startup — keystroke injection requires a live TUI, so there is no lighter way
 * to deliver room messages to an unopened session.
 */
export async function restoreSwitchRoomSessions(): Promise<void> {
  const sessionIds = await switchRoomService.listPersistedSessionIds();
  if (sessionIds.length === 0) return;

  const stale: string[] = [];
  let launched = 0;

  for (const sessionId of sessionIds) {
    try {
      const loaded = await loadSessionWithAgent(sessionId);
      if (!loaded) {
        stale.push(sessionId);
        continue;
      }

      const location = await getLocationById(loaded.locationId);
      if (!location) {
        stale.push(sessionId);
        continue;
      }

      if (!locationManager.getLocation(loaded.locationId)) {
        const opened = await locationManager.openLocation(location);
        if (!opened.success) {
          log.warn('restoreSwitchRoomSessions: failed to open location; skipping session', {
            sessionId,
            locationId: loaded.locationId,
            error: opened.error,
          });
          continue;
        }
      }

      await sessionService.provisionWorkspace(sessionId);
      await hydrateSession(sessionId);
      launched += 1;
    } catch (error) {
      log.warn('restoreSwitchRoomSessions: failed to launch room-connected session', {
        sessionId,
        error: String(error),
      });
    }
  }

  if (stale.length > 0) await switchRoomService.prunePersisted(stale);

  log.info('restoreSwitchRoomSessions: launched room-connected sessions at startup', {
    launched,
    pruned: stale.length,
  });
}
