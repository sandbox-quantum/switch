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
    const status = await checkAcpSignIn(auggieAcp, {
      binaryPath,
      cwd: process.cwd(),
      env,
    });
    return status.status !== 'authenticated' ? status.message : null;
  },
  skip: {
    'user-input':
      'Installed Auggie default model does not expose interactive question tools over ACP.',
    'steer-mid-turn':
      'Auggie ACP operates in sequential turns; turns queue rather than steering the running model call.',
    subagent:
      'Auggie runs within a single conversation model; subagents are not delegated via ACP items.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
