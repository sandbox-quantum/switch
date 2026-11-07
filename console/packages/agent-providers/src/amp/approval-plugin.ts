/**
 * The Amp plugin a session runs with, as source text. Amp has no permission
 * prompt in execute mode: its `tool.call` plugin hook is what decides, before
 * a tool runs, whether it may. This plugin forwards every call to the adapter
 * over a loopback HTTP endpoint and returns Amp's answer only once Switch has
 * decided, so a tool Switch declines never runs, whatever the room shows.
 *
 * It also reports the turn boundaries Amp's plugin API sees (`agent.start`,
 * `agent.end`), which carry the cancelled status the stream-JSON output does
 * not, and polls the adapter for an interrupt to apply with `thread.cancel()`.
 *
 * Amp executes plugins with its bundled Bun, from
 * `$XDG_CONFIG_HOME/amp/plugins/`; the adapter writes this file there for the
 * session. The endpoint and the session's token come from the environment the
 * adapter starts Amp with; without them the plugin does nothing at all, so a
 * copy picked up by someone's own `amp` is inert.
 */
export const AMP_PLUGIN_ENDPOINT_VARIABLE = 'SWITCH_AMP_PLUGIN_ENDPOINT';
export const AMP_PLUGIN_TOKEN_VARIABLE = 'SWITCH_AMP_PLUGIN_TOKEN';

export const AMP_PLUGIN_FILENAME = 'switch-approvals.ts';

export const AMP_APPROVAL_PLUGIN_SOURCE = `// Written by Switch for one agent session; see Switch's agent-providers package.
export const description = 'Switch: approvals, interrupts and turn boundaries for a Switch-run session'

const endpoint = process.env.${AMP_PLUGIN_ENDPOINT_VARIABLE}
const token = process.env.${AMP_PLUGIN_TOKEN_VARIABLE}

async function post(path, body) {
  const response = await fetch(endpoint + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('Switch answered ' + response.status + ' to ' + path)
  return response.json()
}

export default function (amp) {
  if (!endpoint || !token) return
  const threads = new Map()
  let disposed = false

  amp.on('session.start', (event, ctx) => {
    threads.set(event.thread.id, ctx.thread)
    void post('/session-start', { threadId: event.thread.id }).catch(() => {})
  })

  amp.on('agent.start', (event, ctx) => {
    threads.set(event.thread.id, ctx.thread)
    void post('/agent-start', {
      threadId: event.thread.id,
      messageId: String(event.id),
      message: event.message,
    }).catch(() => {})
  })

  amp.on('agent.end', (event) => {
    void post('/agent-end', {
      threadId: event.thread.id,
      messageId: String(event.id),
      status: event.status,
    }).catch(() => {})
  })

  amp.on('tool.call', async (event, ctx) => {
    threads.set(event.thread.id, ctx.thread)
    const shell = amp.helpers.shellCommandFromToolCall(event)
    const request = {
      threadId: event.thread.id,
      toolUseID: event.toolUseID,
      tool: event.tool,
      input: event.input,
      command: shell ? shell.command : null,
    }
    let path = '/tool-call'
    for (;;) {
      let answer
      try {
        answer = await post(path, request)
      } catch (error) {
        return { action: 'reject-and-continue', message: 'Switch could not decide on this tool call: ' + String(error) }
      }
      if (answer.status === 'pending') {
        path = '/tool-call/wait'
        continue
      }
      if (answer.status === 'allow') return { action: 'allow' }
      return { action: 'reject-and-continue', message: answer.message || 'Switch declined this tool call.' }
    }
  })

  async function control() {
    while (!disposed) {
      let command
      try {
        command = await post('/control', {})
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      if (command.kind === 'cancel') {
        const thread = threads.get(command.threadId)
        if (thread) {
          try {
            await thread.cancel()
            void post('/cancelled', { threadId: command.threadId, ok: true }).catch(() => {})
          } catch (error) {
            void post('/cancelled', { threadId: command.threadId, ok: false, error: String(error) }).catch(() => {})
          }
        } else {
          void post('/cancelled', { threadId: command.threadId, ok: false, error: 'unknown thread' }).catch(() => {})
        }
      }
    }
  }

  amp.onDispose(() => {
    disposed = true
  })

  void post('/ready', {}).catch(() => {})
  void control()
}
`;
