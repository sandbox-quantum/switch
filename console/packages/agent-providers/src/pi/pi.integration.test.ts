import { homedir } from 'node:os';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createPiAdapter } from './pi-adapter';
import { checkPiSignIn } from './sign-in';

const BINARY = process.env['SWITCH_PI_BIN'] ?? 'pi';
const MODEL = process.env['SWITCH_PI_MODEL'] ?? 'google/gemini-2.5-flash';

describeConformance('pi', {
  createAdapter: async () => createPiAdapter({ binaryPath: BINARY }),
  unavailableReason: async () => {
    try {
      const signIn = await checkPiSignIn({
        binaryPath: BINARY,
        cwd: homedir(),
        env: process.env as Record<string, string>,
      });
      return signIn.status === 'authenticated' ? null : signIn.message;
    } catch (error) {
      return `\`${BINARY} --list-models\` failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  model: { id: MODEL },
  // Pi reads a provider key from the environment when `/login` stored none.
  env: Object.fromEntries(
    ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'USERPROFILE']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name] as string])
  ),
  mcpServers: { switch_echo: echoMcpServerSpec() },
  timeoutMs: 240_000,
  skip: {
    'user-input':
      'pi 1.4.0 has no tool that asks the user a question: its built-in tools are read, bash, edit, write, grep, find and ls, and RPC mode carries questions only from extensions. Checked 2026-10-28.',
    subagent:
      'pi 1.4.0 has no subagents: it runs one agent loop per session and ships no delegation tool. Checked 2026-10-28.',
  },
});
