import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  type CliConversationList,
  deleteClaudeCliConversationCopies,
  forkClaudeCliConversation,
  listClaudeCliConversations,
} from '../claude/cli-conversations';
import { executionEnvironment } from './shared-config';

/**
 * What the host's one-off conversation commands print instead of their answer
 * when they fail, so Console can say why: the conversation is open in the
 * terminal, say, rather than that a command exited 1.
 */
export const cliConversationFailureSchema = z.object({ error: z.string() });

/** The host's one-off conversation commands. */
export const CLI_CONVERSATION_MODES = [
  '--cli-conversations',
  '--fork-cli-conversation',
  '--delete-cli-conversation-copies',
] as const;
export type CliConversationMode = (typeof CLI_CONVERSATION_MODES)[number];

/**
 * What Console asks a conversation command, staged as a private file because
 * a shell setup may hold secrets a command line would show to `ps`. The
 * session's variables, shell setup and inherited names are what its host would
 * start the provider with, so Claude Code is looked for where the session's
 * Claude Code will look.
 */
export const cliConversationRequestSchema = z.strictObject({
  provider: z.string(),
  dir: z.string().min(1),
  env: z.record(z.string(), z.string()),
  shellSetup: z.string().optional(),
  inheritEnv: z.array(z.string()),
  /** The conversation to copy, for `--fork-cli-conversation`. */
  nativeSessionId: z.string().min(1).optional(),
  /**
   * The Console session a copy is for, for `--fork-cli-conversation`, which
   * tags the copy with it, and `--delete-cli-conversation-copies`, which
   * removes the copies tagged with it.
   */
  consoleSessionId: z.string().min(1).optional(),
  /**
   * The person said the conversation is closed, for a copy where Claude Code
   * cannot say which conversations are open. Absent means they did not.
   */
  confirmedClosed: z.boolean().optional(),
});
export type CliConversationRequest = z.infer<typeof cliConversationRequestSchema>;

/** Answers one of the {@link CLI_CONVERSATION_MODES} for the request at `path`. */
export async function answerCliConversationRequest(
  mode: CliConversationMode,
  path: string
): Promise<CliConversationList | { nativeSessionId: string } | { deleted: number }> {
  const request = cliConversationRequestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (request.provider !== 'claude')
    throw new Error(
      `Switch continues conversations started in Claude Code, not ones started in ${request.provider}.`
    );
  const env = await executionEnvironment(
    request.dir,
    request.env,
    request.shellSetup,
    request.inheritEnv
  );
  if (mode === '--cli-conversations') return listClaudeCliConversations(request.dir, env);
  if (!request.consoleSessionId) throw new Error('Name the Console session the copy is for.');
  if (mode === '--delete-cli-conversation-copies')
    return deleteClaudeCliConversationCopies(request.dir, request.consoleSessionId, env);
  if (!request.nativeSessionId) throw new Error('Name the conversation to copy.');
  return forkClaudeCliConversation(
    {
      dir: request.dir,
      nativeSessionId: request.nativeSessionId,
      consoleSessionId: request.consoleSessionId,
      confirmedClosed: request.confirmedClosed === true,
    },
    env
  );
}
