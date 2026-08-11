// Verbatim source of the Pi Switch Console extension, embedded as a string constant.
export const PI_EXTENSION_CONTENT = `\
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

async function notifySwitchdash(
  eventType: 'stop' | 'error' | 'notification',
  body: Record<string, unknown> = {}
) {
  const port = process.env.SWITCHDASH_HOOK_PORT;
  const token = process.env.SWITCHDASH_HOOK_TOKEN;
  const ptyId = process.env.SWITCHDASH_PTY_ID;

  if (!port || !token || !ptyId) return;

  try {
    await fetch(\`http://127.0.0.1:\${port}/hook\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Switchdash-Token': token,
        'X-Switchdash-Pty-Id': ptyId,
        'X-Switchdash-Event-Type': eventType,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Switch Console may not be running when pi is launched directly; ignore hook failures.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Pi exited with an error';
}

export default function (pi: ExtensionAPI) {
  pi.on('agent_end', async () => {
    await notifySwitchdash('stop', { message: 'Task completed' });
  });

  pi.on('session_shutdown', async (event) => {
    if (event.reason !== 'quit') return;
    await notifySwitchdash('stop', { message: 'Session ended' });
  });

  process.once('uncaughtException', (error) => {
    void notifySwitchdash('error', { message: errorMessage(error) });
  });

  process.once('unhandledRejection', (reason) => {
    void notifySwitchdash('error', { message: errorMessage(reason) });
  });
}
`;
