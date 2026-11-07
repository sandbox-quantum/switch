/**
 * One run: a Claude Code session started as Switch Console starts it, handed
 * one room message, run until its turn ends.
 *
 * Every piece the model sees comes from the shipped modules of the Console
 * tree at `source`, imported rather than copied:
 *
 * - the session itself, from `ClaudeAdapter` — the SDK options, the system
 *   prompt preset and the settings a real session gets;
 * - the system context, `SWITCH_SKILL_CONTEXT` followed by the agent's own
 *   instructions, joined as `session-launch.ts` joins them;
 * - the Switch tools, served by `serveMcpOverHttp` with the MCP server's
 *   instructions, listed and called through `SwitchToolCatalog`;
 * - the message, worded by `roomCommand`.
 *
 * `source` is a parameter so the same harness can run an older tree, for a
 * before-and-after comparison: point it at a worktree of the baseline commit.
 * Only the Switch server behind the tools is fake (`fake-switch.ts`).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeSwitch, type Post, type ToolCall } from './fake-switch';
import type { Scenario } from './scenario';

export type RunResult = {
  posts: Post[];
  calls: ToolCall[];
  /** The model's final text, which a real session shows nobody. */
  finalText: string;
  /** Every tool the model used, in order, Switch's and its own. */
  tools: string[];
  outcome: string;
  usage: unknown;
  seconds: number;
};

/**
 * The harness's own environment, less what a Claude Code session sets for its
 * children: run from inside one, those would make the session under test
 * think it is a nested child of it. Console starts sessions without them.
 */
const PARENT_SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_.*|MESSAGING_.*|SSE_PORT))$/;

function sessionEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !PARENT_SESSION_VARS.test(entry[0])
    )
  );
}

const load = (source: string, path: string) => import(pathToFileURL(join(source, path)).href);

export async function runOnce(input: {
  source: string;
  scenario: Scenario;
  operations: Record<string, unknown>;
  cwd: string;
  model: string | null;
  timeoutMs: number;
  /**
   * Text to use instead of the tree's own, for an ablation: the skill file
   * (frontmatter and all) and the reminder under the message. Everything
   * else still comes from `source`.
   */
  overrides?: { skill?: string; reminder?: string };
}): Promise<RunResult> {
  const { source, scenario } = input;
  const [
    { ClaudeAdapter },
    { roomCommand, roomMessageSchema, REPLY_REMINDER },
    hosted,
    { SWITCH_SKILL_CONTEXT },
  ] =
    await Promise.all([
      load(source, 'packages/agent-providers/src/claude/claude-adapter.ts'),
      load(source, 'packages/agent-providers/src/host/room-prompt.ts'),
      load(source, 'packages/switch-agent-runtime/src/hosted.ts'),
      load(source, 'packages/plugins/src/switch-skill/index.ts'),
    ]);

  const fake = await startFakeSwitch(scenario, input.operations);
  const identity = { endpoint: fake.endpoint, agentId: fake.agentId, token: 'harness' };
  const catalog = new hosted.SwitchToolCatalog(await hosted.loadOperations(identity));
  const ctx = {
    identity,
    connectionId: randomUUID(),
    selector: {},
    room: fake.roomId,
    mediaDir: join(input.cwd, '.switch-media'),
    cwd: input.cwd,
    deadConnection: (operation: string) => `${operation}: the connection is gone.`,
  };
  const token = randomBytes(32).toString('hex');
  const mcp = await hosted.serveMcpOverHttp(token, {
    listTools: async () => catalog.tools(),
    callTool: (name: string, args: Record<string, unknown>) => catalog.call(ctx, name, args),
  });

  const adapter = new ClaudeAdapter();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  let finalText = '';
  const tools: string[] = [];
  const done = new Promise<{ outcome: string; usage: unknown }>((resolve) => {
    adapter.subscribe((event: { type: string; [k: string]: unknown }) => {
      if (event.type === 'item.completed') {
        const item = event.item as { type: string; text?: string; toolName?: string };
        if (item.type === 'assistant_message' && item.text) finalText = item.text;
        else if (item.type !== 'user_message' && item.type !== 'reasoning')
          tools.push(item.toolName ?? item.type);
      }
      if (event.type === 'turn.completed')
        resolve({ outcome: String(event.outcome), usage: event.usage });
      if (event.type === 'session.exited')
        resolve({ outcome: `exited: ${String(event.reason)}`, usage: null });
    });
  });

  const started = Date.now();
  try {
    await adapter.startSession({
      sessionId,
      cwd: input.cwd,
      runtimeMode: 'full-access',
      env: sessionEnv(),
      ...(input.model ? { model: { id: input.model } } : {}),
      mcpServers: {
        switch: { transport: 'http', url: mcp.url, headers: { Authorization: `Bearer ${token}` } },
      },
      connectorMcpServers: [],
      // As `agentSpecialization` in packages/plugins/src/agents/session-launch.ts.
      systemContext: [
        // The same frontmatter strip as packages/plugins/src/switch-skill/index.ts.
        input.overrides?.skill?.replace(/^---\n[\s\S]*?\n---\n+/, '') ?? SWITCH_SKILL_CONTEXT,
        scenario.agentInstructions,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const sender = scenario.room.participants.find((p) => p.name === scenario.message.sender);
    const command = roomCommand({
      agentId: fake.agentId,
      sessionId,
      epoch: '1',
      roomId: fake.roomId,
      message: roomMessageSchema.parse({
        type: 'message',
        payload: {
          sender: `@switch-slack-${scenario.message.sender}:switch.local`,
          sender_name: scenario.message.sender,
          message_id: fake.messageId,
          body: `@${scenario.agentName} ${scenario.message.body}`,
          thread_id: null,
          attachments: [],
          sender_role: sender?.role ?? 'member',
        },
      }),
      surface: 'switch-web',
      attachments: [],
      preface: null,
      firstOfConversation: true,
    });
    let text: string = command.body.text;
    const reminder = input.overrides?.reminder;
    if (reminder !== undefined) {
      if (!text.endsWith(REPLY_REMINDER)) throw new Error('The message does not end with the reminder.');
      text = text.slice(0, text.length - REPLY_REMINDER.length) + reminder;
    }
    await adapter.sendTurn({ sessionId, turnId, text });
    const timeout = new Promise<{ outcome: string; usage: unknown }>((resolve) =>
      setTimeout(() => resolve({ outcome: 'timeout', usage: null }), input.timeoutMs)
    );
    const { outcome, usage } = await Promise.race([done, timeout]);
    return {
      posts: fake.posts,
      calls: fake.calls,
      finalText,
      tools,
      outcome,
      usage,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    await adapter.stopAll().catch(() => undefined);
    await mcp.close();
    await fake.close();
  }
}
