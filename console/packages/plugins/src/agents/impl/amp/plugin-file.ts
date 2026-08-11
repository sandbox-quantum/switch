// Verbatim source of the Amp Switch Console hook plugin, embedded as a string constant.
// This file is intentionally kept as plain TypeScript so it can be inlined at runtime
// without a bundler asset pipeline.
export const AMP_PLUGIN_CONTENT = `\
import type { PluginAPI } from '@ampcode/plugin';

async function notifySwitchdash(eventType: 'start' | 'stop', body: Record<string, unknown> = {}) {
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
    });
  } catch {
    // Switch Console may not be running when Amp is launched directly; ignore hook failures.
  }
}

export default function (amp: PluginAPI) {
  amp.on('agent.start', async () => {
    await notifySwitchdash('start');
  });

  amp.on('agent.end', async () => {
    await notifySwitchdash('stop', { message: 'Task completed' });
  });
}
`;
