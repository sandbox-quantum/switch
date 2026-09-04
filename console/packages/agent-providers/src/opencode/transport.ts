import { createOpencodeClient, type Event, type OpencodeClient } from '@opencode-ai/sdk/v2';
import { ProviderSessionError, ProviderUnavailableError } from '../adapter';
import type { OpencodeConfigFile, OpencodePermissionRule } from './config';
import { type OpencodeSkill, startOpencodeServer } from './server';

export type OpencodeEvent = Event;

export type OpencodePermissionReply = 'once' | 'always' | 'reject';

export interface OpencodePromptInput {
  text: string;
  system?: string;
  model?: { providerID: string; modelID: string };
  files?: Array<{ url: string; mime: string; filename: string }>;
}

export interface OpencodeSessionTransport {
  readonly nativeSessionId: string;
  readonly events: AsyncIterable<OpencodeEvent>;
  prompt(input: OpencodePromptInput): Promise<void>;
  abort(): Promise<void>;
  sessionStatus(): Promise<'busy' | 'idle' | 'unknown'>;
  replyPermission(requestId: string, reply: OpencodePermissionReply): Promise<void>;
  replyQuestion(requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  onExit(listener: (reason: string) => void): void;
  dispose(): Promise<void>;
}

export interface OpencodeTransportInput {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  config: OpencodeConfigFile;
  permission: OpencodePermissionRule[];
  resumeNativeSessionId?: string;
  model?: { providerID: string; modelID: string };
}

export interface OpencodeTransport {
  open(input: OpencodeTransportInput): Promise<OpencodeSessionTransport>;
}

export interface HttpTransportOptions {
  binaryPath: string;
  startupTimeoutMs: number;
  /** Skills to place in each session's isolated config home. */
  skills: OpencodeSkill[];
}

/**
 * One `opencode serve` process per Switch session. OpenCode keys MCP
 * registrations and remembered permission grants by directory, so two sessions
 * sharing a server in one directory would overwrite each other's registrations
 * and widen each other's grants.
 */
export function createHttpTransport(options: HttpTransportOptions): OpencodeTransport {
  return {
    async open(input) {
      const server = await startOpencodeServer({
        binaryPath: options.binaryPath,
        cwd: input.cwd,
        env: input.env,
        config: input.config,
        startupTimeoutMs: options.startupTimeoutMs,
        skills: options.skills,
      });

      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: input.cwd,
        headers: { authorization: server.authorization },
        throwOnError: true,
      });

      const abortController = new AbortController();
      let subscription: AsyncIterable<OpencodeEvent>;
      try {
        const result = await client.event.subscribe(
          { directory: input.cwd },
          { signal: abortController.signal }
        );
        subscription = result.stream;
      } catch (error) {
        server.process.kill('SIGKILL');
        throw new ProviderUnavailableError('opencode', 'could not open the event stream', {
          cause: error,
        });
      }

      let nativeSessionId: string;
      try {
        nativeSessionId = await resolveSession(client, input);
      } catch (error) {
        abortController.abort();
        server.process.kill('SIGKILL');
        throw error;
      }

      const exitListeners = new Set<(reason: string) => void>();
      let disposed = false;
      server.process.on('exit', (code, signal) => {
        if (disposed) return;
        const reason =
          signal !== null
            ? `opencode server was killed by ${signal}`
            : `opencode server exited with code ${code}`;
        for (const listener of exitListeners) listener(reason);
      });

      return {
        nativeSessionId,
        events: subscription,
        async prompt(promptInput) {
          await client.session.promptAsync<true>({
            sessionID: nativeSessionId,
            directory: input.cwd,
            ...(promptInput.model ? { model: promptInput.model } : {}),
            ...(promptInput.system ? { system: promptInput.system } : {}),
            parts: [
              { type: 'text', text: promptInput.text },
              ...(promptInput.files ?? []).map((file) => ({
                type: 'file' as const,
                url: file.url,
                mime: file.mime,
                filename: file.filename,
              })),
            ],
          });
        },
        async abort() {
          await client.session.abort<true>({ sessionID: nativeSessionId, directory: input.cwd });
        },
        async sessionStatus() {
          try {
            const response = await client.session.status<true>({ directory: input.cwd });
            const entry = response.data[nativeSessionId];
            if (entry === undefined) return 'idle';
            return entry.type === 'idle' ? 'idle' : 'busy';
          } catch {
            return 'unknown';
          }
        },
        async replyPermission(requestId, reply) {
          await client.permission.reply<true>({
            requestID: requestId,
            directory: input.cwd,
            reply,
          });
        },
        async replyQuestion(requestId, answers) {
          await client.question.reply<true>({
            requestID: requestId,
            directory: input.cwd,
            answers,
          });
        },
        async rejectQuestion(requestId) {
          await client.question.reject<true>({ requestID: requestId, directory: input.cwd });
        },
        onExit(listener) {
          exitListeners.add(listener);
        },
        async dispose() {
          disposed = true;
          abortController.abort();
          server.process.kill('SIGTERM');
          if (server.process.exitCode === null && server.process.signalCode === null) {
            const escalate = setTimeout(() => server.process.kill('SIGKILL'), 2_000);
            escalate.unref?.();
            server.process.once('exit', () => clearTimeout(escalate));
          }
        },
      };
    },
  };
}

async function resolveSession(
  client: OpencodeClient,
  input: OpencodeTransportInput
): Promise<string> {
  if (input.resumeNativeSessionId !== undefined) {
    const existing = await client.session
      .get<true>({ sessionID: input.resumeNativeSessionId, directory: input.cwd })
      .catch(() => null);
    if (existing === null) {
      throw new ProviderSessionError(
        'opencode',
        input.sessionId,
        `cannot resume: OpenCode has no session '${input.resumeNativeSessionId}'`
      );
    }
    await client.session.update<true>({
      sessionID: existing.data.id,
      directory: input.cwd,
      permission: input.permission,
    });
    return existing.data.id;
  }

  const created = await client.session.create<true>({
    directory: input.cwd,
    permission: input.permission,
    ...(input.model
      ? { model: { providerID: input.model.providerID, id: input.model.modelID } }
      : {}),
  });
  return created.data.id;
}
