import { createAcpAdapter } from '../acp/acp-adapter';
import type {
  ModelSelection,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter';
import { ProviderSessionError } from '../adapter';
import type { ApprovalDecision, ProviderRuntimeEvent, UserInputAnswers } from '../events';
import {
  loginWontHelp,
  readiness,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import type { ProviderLogger } from '../transport/stdio-json-rpc';
import { checkOpencode2SignIn, OPENCODE_CAPABILITIES, opencodeAcpHooks } from './opencode-acp';
import { createOpencodeAdapter } from './opencode-adapter';
import type { OpencodeSkill } from './server';
import { checkOpencodeSignIn } from './sign-in';
import { readOpencodeVersion, type OpencodeLine } from './version';

export interface OpencodeRuntimeOptions {
  binaryPath: string | undefined;
  logger: ProviderLogger | undefined;
  skills: OpencodeSkill[];
}

/**
 * OpenCode, on whichever line the executable is: 1.x through its HTTP server,
 * 2.x through `opencode acp`. The line is read from `opencode --version` as
 * each session starts, so a machine upgraded between two sessions needs
 * nothing restarted, and a session keeps the runtime it started with.
 */
export class OpencodeRuntimeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const;
  readonly capabilities: ProviderCapabilities = OPENCODE_CAPABILITIES;

  private readonly lines: Record<OpencodeLine, ProviderAdapter>;
  private readonly owners = new Map<string, ProviderAdapter>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly binaryPath: string;

  constructor(options: OpencodeRuntimeOptions) {
    this.binaryPath = options.binaryPath ?? 'opencode';
    this.lines = {
      1: createOpencodeAdapter({
        binaryPath: this.binaryPath,
        ...(options.logger ? { logger: options.logger } : {}),
        skills: options.skills,
      }),
      2: createAcpAdapter(opencodeAcpHooks(options.skills), {
        binaryPath: this.binaryPath,
        ...(options.logger ? { logger: options.logger } : {}),
      }),
    };
    for (const adapter of Object.values(this.lines))
      adapter.subscribe((event) => {
        for (const listener of this.listeners) listener(event);
      });
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasSession(sessionId: string): boolean {
    return this.owners.has(sessionId);
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    if (this.owners.has(input.sessionId))
      throw new ProviderSessionError('opencode', input.sessionId, 'session already started');
    const { line } = await readOpencodeVersion({
      binaryPath: this.binaryPath,
      cwd: input.cwd,
      env: input.env,
    });
    const adapter = this.lines[line];
    this.owners.set(input.sessionId, adapter);
    try {
      return await adapter.startSession(input);
    } catch (error) {
      this.owners.delete(input.sessionId);
      throw error;
    }
  }

  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.owner(input.sessionId).sendTurn(input);
  }
  interruptTurn(sessionId: string): Promise<void> {
    return this.owner(sessionId).interruptTurn(sessionId);
  }
  respondToRequest(sessionId: string, requestId: string, decision: ApprovalDecision) {
    return this.owner(sessionId).respondToRequest(sessionId, requestId, decision);
  }
  respondToUserInput(sessionId: string, requestId: string, answers: UserInputAnswers) {
    return this.owner(sessionId).respondToUserInput(sessionId, requestId, answers);
  }
  async canCompact(sessionId: string): Promise<boolean> {
    const adapter = this.owner(sessionId);
    return adapter.compactSession && adapter.canCompact
      ? await adapter.canCompact(sessionId)
      : false;
  }
  async compactSession(sessionId: string): Promise<void> {
    const adapter = this.owner(sessionId);
    if (!adapter.compactSession)
      throw new ProviderSessionError(
        'opencode',
        sessionId,
        'This OpenCode session cannot be compacted from Switch.'
      );
    await adapter.compactSession(sessionId);
  }
  async listModels(sessionId: string) {
    const adapter = this.owner(sessionId);
    return adapter.listModels ? await adapter.listModels(sessionId) : [];
  }
  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const adapter = this.owner(sessionId);
    if (!adapter.setModel)
      throw new ProviderSessionError('opencode', sessionId, 'This OpenCode cannot switch models.');
    await adapter.setModel(sessionId, model);
  }
  async stopSession(sessionId: string): Promise<void> {
    const adapter = this.owners.get(sessionId);
    if (!adapter) return;
    try {
      await adapter.stopSession(sessionId);
    } finally {
      this.owners.delete(sessionId);
    }
  }
  async stopAll(): Promise<void> {
    await Promise.all(Object.values(this.lines).map((adapter) => adapter.stopAll()));
    this.owners.clear();
  }

  private owner(sessionId: string): ProviderAdapter {
    const adapter = this.owners.get(sessionId);
    if (!adapter) throw new ProviderSessionError('opencode', sessionId, 'unknown session');
    return adapter;
  }
}

export function createOpencodeRuntimeAdapter(
  options: OpencodeRuntimeOptions
): OpencodeRuntimeAdapter {
  return new OpencodeRuntimeAdapter(options);
}

/**
 * Whether OpenCode is signed in, asked the way its line answers. A version this
 * build cannot drive, or cannot read, is reported as such: signing in would
 * not fix it.
 */
export async function checkOpencodeSignInAnyLine(
  input: SignInCheckInput
): Promise<ProviderReadiness> {
  let line: OpencodeLine;
  try {
    ({ line } = await readOpencodeVersion(input));
  } catch (error) {
    return loginWontHelp(
      readiness('unknown', error instanceof Error ? error.message : String(error))
    );
  }
  return line === 2 ? await checkOpencode2SignIn(input) : await checkOpencodeSignIn(input);
}
