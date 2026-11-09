import { execProvider } from '../provider-process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAuggieAdapter } from './auggie-adapter';
import { checkAuggieSignIn } from './runtime';

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const env = processEnvironment();
    try {
      await execProvider('auggie', ['--version'], {
        cwd: process.cwd(),
        env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return 'the Auggie CLI is not available on PATH';
    }
    const auth = await checkAuggieSignIn({ binaryPath: 'auggie', cwd: process.cwd(), env });
    return auth.status === 'authenticated' ? null : auth.message;
  },
  mcpServers: { echo: echoMcpServerSpec() },
});