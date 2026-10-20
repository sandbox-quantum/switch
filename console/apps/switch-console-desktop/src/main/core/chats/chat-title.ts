import { tmpdir } from 'node:os';
import { execProvider } from '@switch-console/agent-providers';

const MAX_TITLE = 60;
const MAX_MESSAGE = 2000;

/** The model's reply as a chat name: one line, unquoted, no closing punctuation, capped. */
export function chatTitleFrom(reply: string): string {
  const line = reply.trim().split('\n')[0] ?? '';
  const title = line
    .replace(/^(title:\s*)/i, '')
    .replace(/^["'`“”‘’«»*]+|["'`“”‘’«»*]+$/g, '')
    .replace(/[.!?:;,。]+$/u, '')
    .trim();
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE).trimEnd() : title;
}

/**
 * A short name for a chat from its first message, written by Claude Haiku
 * through the user's own `claude` CLI, so the server needs no model key. No
 * tools, MCP servers, settings or saved session: only the one reply.
 */
export async function generateChatTitle(message: string): Promise<string> {
  // One line: a newline does not survive the cmd.exe quoting a Windows npm install goes through.
  const text = message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
  if (!text) throw new Error('There is no message text to name the chat from.');
  const prompt =
    'Write a title of at most 6 words for a chat that starts with the message below. ' +
    'Use the language of the message. Reply with the title only: no quotes, no punctuation at the end. ' +
    `Message: ${text}`;
  const { stdout } = await execProvider(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      prompt,
    ],
    { cwd: tmpdir(), env: process.env, timeout: 60_000 }
  );
  const title = chatTitleFrom(stdout);
  if (!title) throw new Error(`Claude returned no usable title: ${JSON.stringify(stdout)}`);
  return title;
}
