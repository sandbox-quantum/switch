import { locationManager } from '@main/core/locations/location-manager';
import { getLocationById } from '@main/core/locations/store';
import { ensureSessionAttachable } from '@main/core/sessions/operations/ensureSessionAttachable';
import { hydrateSession } from '@main/core/sessions/operations/hydrateSession';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { sessionService } from '@main/core/sessions/session-service';
import { log } from '@main/lib/logger';
import { switchRoomService } from './switch-room-service';

/**
 * Bring back every session that was connected to a Switch room before the last
 * shutdown, so it receives and responds to room events without the user opening
 * its terminal. Sessions whose row or location no longer exist are pruned.
 *
 * How far to go depends on where the session runs:
 *
 * - **Local**: the agent process is this app's to run, and keystroke injection
 *   requires a live TUI, so the session is hydrated — PTY and all.
 * - **Remote**: the agent lives in a tmux pane on the VM and the on-VM sidecar's
 *   watcher starts it and injects room messages there (`TmuxInjectionSink`), all
 *   without this app. Only the sidecar and its shared hook-event relay are
 *   ensured, which is what feeds status, room membership and notifications back.
 *   No PTY is opened: it would be a terminal nobody is looking at, holding a
 *   channel on a transport every other session on that host shares. One host
 *   with 51 such sessions saturated its tunnel badly enough to wedge the
 *   connection in a loop. The terminal is opened on demand when the session is
 *   actually viewed.
 */
export async function restoreSwitchRoomSessions(): Promise<void> {
  const sessionIds = await switchRoomService.listPersistedSessionIds();
  if (sessionIds.length === 0) return;

  const stale: string[] = [];
  let launched = 0;
  let attachable = 0;
  let orphaned = 0;

  for (const sessionId of sessionIds) {
    try {
      const loaded = await loadSessionWithAgent(sessionId);
      if (!loaded) {
        stale.push(sessionId);
        continue;
      }

      // An agent whose server has been removed still carries that server's
      // endpoint and token, both of which now point at nothing. Launching it
      // would spawn an agent process that can never reach its room, so say so
      // rather than starting a poller that fails forever. The session is left
      // intact and can still be opened by hand.
      if (loaded.serverId === null) {
        orphaned += 1;
        log.warn('restoreSwitchRoomSessions: agent has no Switch server; not restoring session', {
          event: 'switch_room_restore_skipped',
          reason: 'agent_server_removed',
          sessionId,
          agentName: loaded.name,
        });
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

      await sessionService.provisionSession(sessionId);
      if (await ensureSessionAttachable(sessionId)) {
        attachable += 1;
      } else {
        await hydrateSession(sessionId);
        launched += 1;
      }
    } catch (error) {
      log.warn('restoreSwitchRoomSessions: failed to launch room-connected session', {
        sessionId,
        error: String(error),
      });
    }
  }

  if (stale.length > 0) await switchRoomService.prunePersisted(stale);

  log.info('restoreSwitchRoomSessions: restored room-connected sessions at startup', {
    // `launched` spawned an agent locally; `attachable` only ensured the remote
    // sidecar + relay, leaving the terminal to be opened on demand.
    launched,
    attachable,
    pruned: stale.length,
    orphaned,
  });
}
