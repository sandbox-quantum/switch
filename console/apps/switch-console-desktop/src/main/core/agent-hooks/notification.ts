import { eq } from 'drizzle-orm';
import { app, BrowserWindow, Notification } from 'electron';
import { getMainWindow } from '@main/app/window';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { appSettingsService } from '@main/core/settings/settings-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { getProvider, type AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { isAttentionNotification, type AgentEvent } from '@shared/core/providers/agentEvents';
import { notificationFocusSessionChannel } from '@shared/events/appEvents';

const activeNotifications = new Set<Notification>();

function focusAppFromNotification(): BrowserWindow | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;

  if (win.isMinimized()) win.restore();
  win.show();

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  } else {
    app.focus();
  }

  win.focus();
  return win;
}

function getNotificationBody(event: AgentEvent): string | null {
  if (event.type === 'stop') return 'Your agent has finished working';
  if (event.type === 'notification') {
    const { notificationType } = event.payload;
    if (!notificationType) return null;
    if (isAttentionNotification(notificationType)) {
      return 'Your agent is waiting for input';
    }
  }
  return null;
}

async function getSessionName(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({ name: sessions.title })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.name ?? null;
}

export async function maybeShowNotification(event: AgentEvent, appFocused: boolean): Promise<void> {
  try {
    const { enabled, osNotifications } = await appSettingsService.get('notifications');
    if (!enabled || !osNotifications || appFocused || !Notification.isSupported()) return;

    const body = getNotificationBody(event);
    if (!body) return;

    const providerName = getProvider(event.providerId as AgentProviderId)?.name ?? event.providerId;
    const sessionName = await getSessionName(event.sessionId);
    const title = sessionName ? `${providerName} — ${sessionName}` : providerName;

    const notification = new Notification({ title, body, silent: true });
    activeNotifications.add(notification);

    const releaseNotification = () => activeNotifications.delete(notification);
    notification.on('close', releaseNotification);
    notification.on('failed', releaseNotification);
    notification.on('click', () => {
      const win = focusAppFromNotification();
      if (!win) return;

      releaseNotification();
      if (event.sessionId) {
        void loadSessionWithAgent(event.sessionId).then((loaded) => {
          if (!loaded) return;
          events.emit(notificationFocusSessionChannel, {
            agentId: loaded.row.agentId,
            sessionId: event.sessionId,
          });
        });
      }
    });

    notification.show();
  } catch (error) {
    log.warn('notification: failed to show OS notification', { error: String(error) });
  }
}

export function isAppFocused(): boolean {
  const windows = BrowserWindow.getAllWindows();
  return windows.some((w) => !w.isDestroyed() && w.isFocused());
}
