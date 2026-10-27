import { checkAcpSignIn } from '../acp/acp-adapter';
import { findOnPath } from '../provider-process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { auggieAcp, createAuggieAdapter } from './auggie-acp';

const env = Object.fromEntries(
  (auggieAcp.inheritEnv ?? []).flatMap((key) =>
    process.env[key] ? [[key, process.env[key]!]] : []
  )
);

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const binaryPath = await findOnPath('auggie', process.env.PATH);
    if (!binaryPath) return 'the Auggie binary is not on PATH';
    const result = await checkAcpSignIn(auggieAcp, {
      binaryPath,
      cwd: process.cwd(),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
        ),
        ...env,
      },
    });
    return result.status === 'authenticated' ? null : result.message;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
