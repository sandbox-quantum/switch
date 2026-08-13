// Verbatim copy of `connectors/opencode-plugin/plugin/switch-notifications.js`.
//
// That file is the source of truth — edit it, not this. The app carries this
// copy because it writes the connector itself rather than fetching it from a
// marketplace, and `connector-assets.test.ts` fails if the two drift. Drift
// here is silent and nasty: the connector directory is what gets reviewed,
// while sessions run whatever is embedded below.
export const OPENCODE_PLUGIN_CONTENT = `\
/* global fetch, process */

// Identifies this plugin build in OpenCode's own log. The file is dropped into
// a working directory and can go stale there, so the load line is the only way
// to tell which version an agent actually has.
const BUILD_TAG = 'turn-cycle-v4-tool-activity';

export const SwitchdashNotifications = async (input) => {
  // OpenCode has no "assistant started working" event, so the working ->
  // completed turn cycle is derived from the events it does emit: a turn starts
  // on a NEW user message and ends on session.idle.
  //
  // Both halves of that are narrower than they look, and neither is obvious
  // from the event names:
  //
  //   - Assistant activity does NOT start a turn. OpenCode keeps emitting
  //     message.updated / message.part.updated after session.idle, finalizing
  //     the last assistant message and running its auto title-generation call.
  //   - "Any user message" does not either. OpenCode re-emits the user message
  //     about 20ms AFTER session.idle to attach final token and cost stats, so
  //     matching on role alone rebounds straight back to working. Only a
  //     message id we have not already opened a turn with counts.
  //
  // Getting either wrong leaves a session that looks permanently busy in its
  // rooms, which is why the id is tracked rather than just the role.
  let working = false;
  let lastTurnUserMessageId = null;

  // Logging goes through client.app.log, never the console: OpenCode renders a
  // plugin's stdout/stderr straight into the TUI, where it corrupts the display
  // around the input box. These land in OpenCode's own log files instead.
  const client = input?.client;
  const logLine = async (level, message, extra) => {
    if (!client?.app?.log) return;
    try {
      await client.app.log({
        body: { service: 'switchdash-notifications', level, message, extra },
      });
    } catch {
      // Logging is best-effort and must never interrupt OpenCode.
    }
  };
  // Turn boundaries and tool activity log at info so they appear at OpenCode's
  // default level — these are the two things that fail silently, and needing a
  // --log-level flag to see them means restarting the session you wanted to
  // diagnose. The per-event firehose stays at debug.
  const logInfo = (message, extra) => logLine('info', message, extra);
  const logDebug = (message, extra) => logLine('debug', message, extra);

  await logInfo('plugin loaded', { build: BUILD_TAG });

  async function postTool(type, toolName, toolInput) {
    const port = process.env.SWITCHDASH_HOOK_PORT;
    const token = process.env.SWITCHDASH_HOOK_TOKEN;
    const ptyId = process.env.SWITCHDASH_PTY_ID;
    if (!port || !token || !ptyId) return;
    if (typeof toolName !== 'string' || !toolName) return;
    await logInfo('tool activity -> switch console', { type, tool: toolName });
    await postToSwitchdash({
      port,
      token,
      ptyId,
      type,
      body: { tool_name: toolName, tool_input: toolInput || {} },
    });
  }

  return {
    event: async ({ event }) => {
      const port = process.env.SWITCHDASH_HOOK_PORT;
      const token = process.env.SWITCHDASH_HOOK_TOKEN;
      const ptyId = process.env.SWITCHDASH_PTY_ID;

      const role =
        typeof event.properties?.info?.role === 'string' ? event.properties.info.role : undefined;
      await logDebug('event', {
        type: event.type,
        role,
        working,
        managed: Boolean(port && token && ptyId),
      });

      if (!port || !token || !ptyId) return;
      const target = { port, token, ptyId };

      const sessionId = getOpenCodeSessionId(event);
      if (sessionId) {
        await postToSwitchdash({ ...target, type: 'session', body: { sessionId } });
      }

      if (event.type === 'message.updated' && role === 'user') {
        const messageId =
          typeof event.properties?.info?.id === 'string' ? event.properties.info.id : undefined;
        if (messageId && messageId !== lastTurnUserMessageId) {
          lastTurnUserMessageId = messageId;
          if (!working) {
            working = true;
            await logInfo('turn start -> working', {
              trigger: 'message.updated role=user',
              messageId,
            });
            await postToSwitchdash({ ...target, type: 'start', body: {} });
          }
        }
        return;
      }

      // Gated on \`working\` so an idle outside a turn — at session start, or
      // trailing after one already completed — does not report a turn that
      // never ran.
      if (event.type === 'session.idle') {
        if (working) {
          working = false;
          await logInfo('turn end -> completed', { trigger: 'session.idle' });
          await postToSwitchdash({ ...target, type: 'stop', body: {} });
        }
        return;
      }

      if (event.type === 'session.error') {
        working = false;
        await logInfo('turn error', { trigger: 'session.error' });
        await postToSwitchdash({
          ...target,
          type: 'error',
          body: {
            title: 'OpenCode error',
            message:
              typeof event.properties?.error === 'string' ? event.properties.error : undefined,
          },
        });
        return;
      }
    },

    // Each tool call as it starts and finishes, so the bridged "working on it"
    // message can be refreshed in place with the live step. This feeds the
    // runtime-state detail line, not observability — the coarse status stays
    // "working" throughout, and the compact label is derived on the Switch
    // Console side from tool_name and tool_input.
    'tool.execute.before': async (toolInput, output) => {
      await postTool('tool-use', toolInput?.tool, output?.args);
    },
    'tool.execute.after': async (toolInput) => {
      await postTool('tool-done', toolInput?.tool, undefined);
    },
  };
};

async function postToSwitchdash({ port, token, ptyId, type, body }) {
  try {
    await fetch(\`http://127.0.0.1:\${port}/hook\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Switchdash-Token': token,
        'X-Switchdash-Pty-Id': ptyId,
        'X-Switchdash-Event-Type': type,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Hook delivery is best-effort and must never interrupt OpenCode.
  }
}

function getOpenCodeSessionId(event) {
  if (!event.type?.startsWith('session.')) return undefined;

  const infoId = event.properties?.info?.id;
  if (isOpenCodeSessionId(infoId)) return infoId.trim();

  const sessionId = event.properties?.sessionID;
  if (isOpenCodeSessionId(sessionId)) return sessionId.trim();

  return undefined;
}

function isOpenCodeSessionId(value) {
  return typeof value === 'string' && value.trim().startsWith('ses');
}
`;
