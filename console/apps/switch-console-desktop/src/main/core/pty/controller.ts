import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { err, ok } from '@switch-console/shared';
import { locationRuntimeRegistry } from '@main/core/locations/location-runtime-registry';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { log } from '@main/lib/logger';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { sessionRuntimeManager } from '../sessions/session-runtime-manager';
import { recordHumanInput } from './human-activity';
import {
  cleanupExpiredDroppedBlobs,
  persistClipboardImagePath,
  persistDroppedBlobBytes,
} from './persist-dropped-blob';
import { ptySessionRegistry } from './pty-session-registry';

void cleanupExpiredDroppedBlobs().catch((error) => {
  log.warn('pty:cleanupExpiredDroppedBlobs failed', { error });
});

export const ptyController = createRPCController({
  /** Send raw input data to a PTY session. */
  sendInput: (sessionId: string, data: string) => {
    const pty = ptySessionRegistry.get(sessionId);
    if (!pty) return err({ type: 'not_found' as const });
    // Mark operator activity so the Switch poller defers injection while the
    // human is typing into this pane (dual-writer gate).
    recordHumanInput(sessionId);
    pty.write(data);
    if (data.includes('\r')) {
      const meta = ptySessionRegistry.getMetadata(sessionId);
      if (meta?.providerId && !meta.isRemote) {
        const parsed = parsePtySessionId(sessionId);
        if (parsed) {
          sessionHooks._emit('session:input-submitted', {
            sessionId: parsed.scopeId,
            providerId: meta.providerId,
          });
        }
      }
    }
    return ok();
  },

  /** Resize a PTY session to the given terminal dimensions. */
  resize: (sessionId: string, cols: number, rows: number) => {
    const resized = ptySessionRegistry.resize(sessionId, cols, rows);
    if (!resized) return err({ type: 'not_found' as const });
    return ok();
  },

  /**
   * Atomically return the ring buffer and register the renderer as a consumer
   * for future IPC delivery. Non-destructive — the ring buffer is kept intact.
   * Called once by the renderer when connecting a FrontendPty to a session.
   */
  subscribe: (sessionId: string) => {
    return ok({ buffer: ptySessionRegistry.subscribe(sessionId) });
  },

  /**
   * Remove the renderer's consumer registration for a session.
   * Called when the renderer disposes its FrontendPty.
   */
  unsubscribe: (sessionId: string) => {
    ptySessionRegistry.unsubscribe(sessionId);
    return ok();
  },

  /** Kill a PTY session and clean it up immediately. */
  kill: (sessionId: string) => {
    const pty = ptySessionRegistry.get(sessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('ptyController.kill: error killing PTY', { sessionId, error: String(e) });
      }
    }
    ptySessionRegistry.unregister(sessionId);
    return ok();
  },

  /**
   * Stop a lifecycle-script PTY for good. Lifecycle scripts never respawn, so
   * a raw kill is sufficient and safe.
   *
   * Agent PTYs are session lifecycle, not raw PTY I/O — stop those through
   * `rpc.sessions.stopAgent` instead; this rejects them.
   */
  stopSession: async (sessionId: string) => {
    const parsed = parsePtySessionId(sessionId);
    if (!parsed) return err({ type: 'invalid_session' as const });

    // Agent PTYs carry a providerId in their registry metadata; lifecycle
    // scripts do not — that distinguishes the two.
    if (ptySessionRegistry.getMetadata(sessionId)?.providerId !== undefined) {
      return err({ type: 'invalid_session' as const });
    }

    // Lifecycle scripts are the only PTYs stopped here (no session match) and
    // never respawn, so a raw kill is sufficient and safe.
    const pty = ptySessionRegistry.get(sessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('ptyController.stopSession: error killing PTY', { sessionId, error: String(e) });
      }
    }
    ptySessionRegistry.unregister(sessionId);
    return ok();
  },

  /**
   * Upload local files into the session's working directory on a remote SSH host
   * and return their remote paths.  Uses the SFTP subsystem of the already-
   * connected ssh2 client — no local ssh/scp binaries are involved.
   *
   * The session ID encodes the location and scope (`locationId:scopeId:leafId`),
   * where `scopeId` is a session ID for agent-session uploads.
   */
  uploadFiles: async (args: { sessionId: string; localPaths: string[] }) => {
    try {
      const parsed = parsePtySessionId(args.sessionId);
      if (!parsed) {
        return err({ type: 'invalid_session' as const });
      }
      const { scopeId } = parsed;

      if (!sessionRuntimeManager.getAgent(scopeId)) return err({ type: 'not_ssh' as const });

      const locationId = sessionRuntimeManager.getLocationId(scopeId) ?? '';
      const runtime = locationRuntimeRegistry.get(locationId);
      if (!runtime?.fs.copyLocalFile) return err({ type: 'not_ssh' as const });

      const remotePaths = await Promise.all(
        args.localPaths.map(async (localPath) => {
          const remoteName = `${randomUUID()}-${basename(localPath)}`;
          await runtime.fs.copyLocalFile!(localPath, remoteName);
          return `${runtime.path}/${remoteName}`;
        })
      );
      return ok({ remotePaths });
    } catch (e: unknown) {
      log.error('pty:uploadFiles failed', {
        sessionId: args.sessionId,
        error: (e as Error)?.message || e,
      });
      return err({ type: 'upload_failed' as const, message: String((e as Error)?.message || e) });
    }
  },

  /**
   * Persist a dropped or pasted in-memory image to a stable temp file.
   * HEIC/HEIF bytes are converted to PNG so Claude Code can inline them.
   */
  persistDroppedBlob: async (args: { bytes: Uint8Array; name?: string; mimeType?: string }) => {
    try {
      const path = await persistDroppedBlobBytes(args);
      return ok({ path });
    } catch (e: unknown) {
      log.error('pty:persistDroppedBlob failed', {
        error: (e as Error)?.message || e,
      });
      return err({ type: 'persist_failed' as const, message: String((e as Error)?.message || e) });
    }
  },

  /** Persist the OS clipboard image (macOS HEIC paste, screenshots, etc.). */
  persistClipboardImage: async () => {
    try {
      const path = await persistClipboardImagePath();
      return ok({ path });
    } catch (e: unknown) {
      log.error('pty:persistClipboardImage failed', {
        error: (e as Error)?.message || e,
      });
      return err({ type: 'persist_failed' as const, message: String((e as Error)?.message || e) });
    }
  },
});
