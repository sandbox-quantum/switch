import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDotEnv } from '../core/env.ts';

/**
 * One call to a pinned model, through the Claude Code CLI: the same binary,
 * and the same credentials, the agent controller runs sessions with, so the
 * lane needs no second way of reaching a model.
 *
 * The call is stripped to a plain completion: its own system prompt, no tools,
 * no MCP servers, no settings, no saved session, from an empty directory. That
 * keeps a developer's plugins, hooks and CLAUDE.md out of it, and keeps its
 * cost to the tokens it is actually given (a default call carries Claude
 * Code's whole system prompt, about seventy times the cost of a short reply).
 *
 * The model is never chosen here: a call names one, and an answer from any
 * other model is refused rather than counted.
 */

export interface ModelAnswer {
  text: string;
  costUsd: number;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

const CALL_TIMEOUT_MS = 3 * 60_000;

export class ModelClient {
  private readonly env: NodeJS.ProcessEnv;

  /** `providerEnvFile`: keys to add to the CLI's environment, or null for its own sign-in. */
  constructor(providerEnvFile: string | null) {
    this.env = { ...process.env };
    if (providerEnvFile !== null) {
      Object.assign(this.env, parseDotEnv(readFileSync(providerEnvFile, 'utf8')));
    }
  }

  async ask(params: {
    model: string;
    system: string;
    prompt: string;
    /** The most this one call may spend; the CLI stops it there. */
    maxUsd: number;
  }): Promise<ModelAnswer> {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-model-'));
    try {
      const raw = await run(
        [
          '-p',
          '--model',
          params.model,
          '--system-prompt',
          params.system,
          '--tools',
          '',
          '--strict-mcp-config',
          '--setting-sources',
          '',
          '--no-session-persistence',
          '--max-budget-usd',
          params.maxUsd.toFixed(4),
          '--output-format',
          'json',
        ],
        params.prompt,
        dir,
        this.env
      );
      return parseAnswer(raw, params.model);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The CLI's JSON result, held to the model that was asked for. */
export function parseAnswer(raw: string, model: string): ModelAnswer {
  let result: {
    result?: unknown;
    is_error?: unknown;
    total_cost_usd?: unknown;
    modelUsage?: Record<string, unknown>;
  };
  try {
    result = JSON.parse(raw) as typeof result;
  } catch {
    throw new ModelError(`The Claude Code CLI did not answer with JSON: ${raw.slice(0, 300)}`);
  }
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error === true) {
    throw new ModelError(`The call to ${model} failed: ${text.slice(0, 300)}`);
  }
  const answered = Object.keys(result.modelUsage ?? {});
  if (!answered.includes(model)) {
    throw new ModelError(
      `Asked ${model}, but the answer came from ${answered.join(', ') || 'no model'}. ` +
        `The lane refuses a substitute: name a model these credentials can use.`
    );
  }
  if (typeof result.total_cost_usd !== 'number') {
    throw new ModelError(`The call to ${model} reported no cost.`);
  }
  return { text: text.trim(), costUsd: result.total_cost_usd };
}

function run(args: string[], stdin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new ModelError(`The Claude Code CLI did not answer within ${CALL_TIMEOUT_MS / 1000} s.`)
      );
    }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ModelError(`Could not run the Claude Code CLI ('claude'): ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A failed call still prints its JSON result, which says why.
      if (stdout.trim() !== '') resolve(stdout);
      else reject(new ModelError(`The Claude Code CLI exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.end(stdin);
  });
}
