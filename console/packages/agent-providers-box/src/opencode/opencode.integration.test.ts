import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createOpencodeAdapter } from './opencode-adapter';

const run = promisify(execFile);

const BINARY = process.env['SWITCH_OPENCODE_BIN'] ?? 'opencode';
const MODEL = process.env['SWITCH_OPENCODE_MODEL'] ?? 'opencode/big-pickle';

describeConformance('opencode', {
  createAdapter: async () => createOpencodeAdapter({ binaryPath: BINARY }),
  unavailableReason: async () => {
    try {
      const { stdout } = await run(BINARY, ['models'], { timeout: 60_000 });
      const models = stdout.split('\n').map((line) => line.trim());
      if (!models.includes(MODEL)) return `${MODEL} is not in \`${BINARY} models\``;
      return null;
    } catch (error) {
      return `\`${BINARY} models\` failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  model: { id: MODEL },
  mcpServers: { switch_echo: echoMcpServerSpec() },
  timeoutMs: 240_000,
});
