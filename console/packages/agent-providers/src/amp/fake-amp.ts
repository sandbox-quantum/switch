/**
 * A stand-in for the `amp` CLI, enough of it for the adapter's tests: `account
 * list`, `threads new`, and `threads continue <id> --execute --stream-json
 * --stream-json-input` speaking stream JSON. Tool permissions are evaluated
 * from `--settings-file` as Amp does: rules in order, `allow`, or `delegate`
 * to a program that gets the input on stdin and answers with its exit status.
 *
 * What a turn does is chosen by its message:
 * - `run: <command>` calls the Bash tool with that command, then says "done";
 * - `slow` waits for another message (steering) or a signal, then answers it;
 * - anything else is echoed back as `echo: <text>`.
 *
 * Every invocation's arguments are appended to `FAKE_AMP_LOG` as JSON.
 */
export const FAKE_AMP_SCRIPT = String.raw`
const { appendFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');

const args = process.argv.slice(2);
if (process.env.FAKE_AMP_LOG) appendFileSync(process.env.FAKE_AMP_LOG, JSON.stringify(args) + '\n');
const loginFlow = () => {
  console.log('No API key found. Starting login flow...');
  console.log('To log in, visit: https://ampcode.com/auth/cli/device?user_code=TEST');
  setInterval(() => {}, 1000);
};

if (args[0] === 'account' && args[1] === 'list') {
  if (process.env.FAKE_AMP_LOGIN_FLOW) return loginFlow();
  console.log(process.env.FAKE_AMP_ACCOUNTS ? 'person@example.com (active)' : 'No saved accounts.');
  process.exit(0);
}
if (args[0] === 'threads' && args[1] === 'new') {
  if (process.env.FAKE_AMP_LOGIN_FLOW) return loginFlow();
  console.log('https://ampcode.com/threads/T-0e7c5b1a-1111-4222-8333-444455556666');
  process.exit(0);
}
if (!(args[0] === 'threads' && args[1] === 'continue')) {
  console.error('fake amp: unsupported ' + args.join(' '));
  process.exit(1);
}

const thread = args[2];
const settingsPath = args[args.indexOf('--settings-file') + 1];
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const out = (message) => process.stdout.write(JSON.stringify({ ...message, session_id: thread }) + '\n');
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
const say = (text, stop = 'end_turn') =>
  out({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop, usage },
  });
const echo = (text) =>
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });

function permitted(tool, input) {
  if (settings['amp.dangerouslyAllowAll']) return { allowed: true };
  for (const rule of settings['amp.permissions'] ?? []) {
    const pattern = new RegExp('^' + rule.tool.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (!pattern.test(tool)) continue;
    if (rule.action === 'allow') return { allowed: true };
    if (rule.action === 'reject') return { allowed: false, error: 'rejected by rule' };
    if (rule.action === 'delegate') {
      const run = spawnSync(rule.to, [], {
        input: JSON.stringify(input),
        env: { ...process.env, AGENT: 'amp', AGENT_TOOL_NAME: tool, AGENT_TOOL_USE_ID: 'toolu_1' },
        encoding: 'utf8',
      });
      return run.status === 0 ? { allowed: true } : { allowed: false, error: run.stderr };
    }
  }
  return { allowed: false, error: 'no rule' };
}

out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Bash'], mcp_servers: [], subagents: [] });
// Earlier work Amp resumes before the new message: not part of this turn.
if (process.env.FAKE_AMP_EARLIER_WORK) say('left over from an earlier turn');

const pending = [];
let waiting = null;
let closed = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (waiting) {
    const resolve = waiting;
    waiting = null;
    resolve(message);
  } else pending.push(message);
});
lines.on('close', () => {
  closed = true;
  if (waiting) waiting(null);
});
const next = () =>
  pending.length ? Promise.resolve(pending.shift()) : closed ? Promise.resolve(null) : new Promise((resolve) => (waiting = resolve));
const textOf = (message) => message.message.content.find((block) => block.type === 'text').text;

(async () => {
  let turns = 0;
  for (let message = await next(); message; message = await next()) {
    const text = textOf(message);
    echo(text);
    turns += 1;
    if (text.startsWith('run: ')) {
      const input = { cmd: text.slice(5) };
      out({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }], stop_reason: 'tool_use', usage },
      });
      const verdict = permitted('Bash', input);
      out({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: verdict.allowed ? 'ran ' + input.cmd : 'denied: ' + verdict.error.trim(),
              is_error: !verdict.allowed,
            },
          ],
        },
      });
      say('done');
    } else if (text === 'slow') {
      say('counting', null);
      const steer = await next();
      if (!steer) break;
      echo(textOf(steer));
      say('steered: ' + textOf(steer));
    } else say('echo: ' + text);
  }
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: turns, result: '', usage, duration_ms: 1 });
  process.exit(0);
})();
`;
