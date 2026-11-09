import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { z } from 'zod';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import { ACP_CANCELLED, type AcpPermissionRequest, type AcpToolCall } from '../acp/protocol';
import { readiness } from '../readiness';

const QWEN_SIGN_IN =
  'Run qwen on the execution machine and choose a provider with /auth, or set its API key in the environment.';

// The key each of Qwen's auth types reads when no model provider names its own.
const DEFAULT_KEYS = new Map([
  ['openai', 'OPENAI_API_KEY'],
  ['openai-responses', 'OPENAI_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['gemini', 'GEMINI_API_KEY'],
  ['vertex-ai', 'GOOGLE_API_KEY'],
]);

const settingsSchema = z.object({
  env: z.record(z.string(), z.unknown()).optional(),
  model: z.object({ name: z.string().optional() }).optional(),
  modelProviders: z
    .record(z.string(), z.array(z.object({ id: z.string(), envKey: z.string().optional() })))
    .optional(),
  security: z
    .object({
      auth: z
        .object({ selectedType: z.string().optional(), apiKey: z.string().optional() })
        .optional(),
    })
    .optional(),
});
type QwenSettings = z.infer<typeof settingsSchema>;

function userHome(env: Record<string, string>): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Qwen's own directory on the execution host: `QWEN_HOME`, resolved as Qwen does, else `~/.qwen`. */
export function qwenHome(env: Record<string, string>, cwd: string): string {
  const dir = env.QWEN_HOME;
  if (!dir) return join(userHome(env), '.qwen');
  if (dir === '~' || /^~[/\\]/.test(dir)) return join(userHome(env), dir.slice(2));
  return resolve(cwd, dir);
}

/** `settings.json`, which Qwen lets carry comments and trailing commas. */
function parseSettings(text: string | undefined): QwenSettings {
  if (!text?.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('settings.json is not valid JSON.');
  return settingsSchema.parse(value ?? {});
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The names a `.env` file sets to a non-empty value. */
function dotenvNames(text: string | undefined): Set<string> {
  const names = new Set<string>();
  for (const line of text?.split(/\r?\n/) ?? []) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[2]!.replace(/^['"]|['"]$/g, '').trim()) names.add(match[1]!);
  }
  return names;
}

/**
 * Whether Qwen Code can make a model call, read the way its startup check
 * reads it: the auth type chosen in `settings.json`, then that type's key, from
 * the model provider's `envKey` or the type's default variable, in the
 * environment, the settings' `env`, `security.auth.apiKey` or a user-level
 * `.env`. Nothing is started and no model is called.
 */
export async function qwenSignIn(env: Record<string, string>, cwd: string) {
  const home = userHome(env);
  const dir = qwenHome(env, cwd);
  let settings: QwenSettings;
  try {
    settings = parseSettings(await readOptional(join(dir, 'settings.json')));
  } catch {
    return readiness(
      'unknown',
      `Could not read Qwen Code's settings in ${dir}. Check settings.json on the execution machine.`
    );
  }
  const type = settings.security?.auth?.selectedType;
  if (!type) return readiness('unconfigured', QWEN_SIGN_IN);
  if (type === 'qwen-oauth')
    return readiness(
      'unauthenticated',
      `Qwen OAuth's free tier ended on 2026-04-15. ${QWEN_SIGN_IN}`
    );
  const model = settings.model?.name;
  const envKey = Object.values(settings.modelProviders ?? {})
    .flat()
    .find((entry) => entry.id === model && entry.envKey)?.envKey;
  const key = envKey ?? DEFAULT_KEYS.get(type);
  if (!key) return readiness('unknown', `Qwen Code is set to sign in with ${type}.`);
  const settingsValue = settings.env?.[key];
  const found =
    Boolean(env[key]?.trim()) ||
    (typeof settingsValue === 'string' && Boolean(settingsValue.trim())) ||
    // A provider's own `envKey` is the only key Qwen reads for it.
    (!envKey && Boolean(settings.security?.auth?.apiKey?.trim())) ||
    (
      await Promise.all(
        [join(home, '.env'), join(dir, '.env'), join(home, '.qwen', '.env')].map(readOptional)
      )
    ).some((text) => dotenvNames(text).has(key));
  return found
    ? readiness(
        'authenticated',
        `Qwen Code signs in with ${type}. The key is checked on the first turn.`
      )
    : readiness(
        'unauthenticated',
        `Qwen Code is set to ${type} but ${key} is not set. ${QWEN_SIGN_IN}`
      );
}

function qwenMeta(toolCall: AcpToolCall): Record<string, unknown> {
  return toolCall._meta ?? {};
}

interface QwenQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

// Approvals Qwen writes into its settings as rules, which Switch never offers.
const SAVED_FOR_GOOD = new Set([
  'proceed_always_project',
  'proceed_always_user',
  'proceed_always_server',
  'proceed_always_tool',
]);

/**
 * Qwen's `ask_user_question` tool reaches the client as a permission request
 * with its questions in `_meta`. Its answer is the request's `proceed_once`
 * option with `answers`, keyed by question index, each the chosen labels.
 */
function askQuestions(
  context: AcpSessionContext,
  { toolCall, options }: AcpPermissionRequest
): Promise<unknown> | undefined {
  const meta = qwenMeta(toolCall);
  if (meta.qwenInteractionKind !== 'user_question') return undefined;
  const questions = (meta.qwenQuestions ?? []) as QwenQuestion[];
  const submit = options.find((option) => option.kind === 'allow_once');
  if (!submit || !questions.length) return Promise.resolve(ACP_CANCELLED);
  return context.askQuestions(
    questions.map((q, index) => ({
      id: String(index),
      ...(q.header ? { header: q.header } : {}),
      question: q.question,
      options: q.options.map((o) => ({
        label: o.label,
        value: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
      multiSelect: q.multiSelect ?? false,
      allowCustomAnswer: false,
    })),
    (selected) => ({
      outcome: { outcome: 'selected', optionId: submit.optionId },
      answers: Object.fromEntries(
        selected.map(({ questionId, values }) => [questionId, values.join(', ')])
      ),
    })
  );
}

/** Qwen Code's `qwen --acp`. */
export const qwenAcp: AcpProviderHooks = {
  provider: 'qwen',
  label: 'Qwen Code',
  defaultBinary: 'qwen',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: 'qwen',
  inheritEnv: [
    'QWEN_HOME',
    'QWENCLOUD_API_KEY',
    'QWENCLOUD_TOKEN_PLAN_API_KEY',
    'BAILIAN_TOKEN_PLAN_API_KEY',
    'REQUESTY_API_KEY',
  ],
  checkSignIn: ({ env, cwd }) => qwenSignIn(env, cwd),
  // Qwen's default mode is `auto`, its own classifier, which approves without
  // asking; every session is therefore put in the mode Switch chose.
  sessionMode: (mode) => {
    switch (mode) {
      case 'approval-required':
        return 'default';
      case 'auto-accept-edits':
        return 'auto-edit';
      case 'auto':
        return 'auto';
      case 'full-access':
        return 'yolo';
    }
  },
  // MCP tools are named `mcp__<server>__<tool>`.
  mcpServerOf: (toolCall) => {
    const name = qwenMeta(toolCall).toolName;
    return typeof name === 'string' ? /^mcp__(.+?)__/.exec(name)?.[1] : undefined;
  },
  itemType: (toolCall) => (qwenMeta(toolCall).toolName === 'agent' ? 'subagent' : undefined),
  permission: (context, request) => {
    request.options = request.options.filter((option) => !SAVED_FOR_GOOD.has(option.optionId));
    return askQuestions(context, request);
  },
};

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
