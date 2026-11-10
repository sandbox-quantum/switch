import { checkAcpSignIn } from '../acp/acp-adapter';
import { findOnPath } from '../provider-process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { auggieAcp, createAuggieAdapter } from './auggie-acp';

// The harness hands the CLI a minimal environment (PATH, HOME and a few
// basics), so a session given in the shell would not reach it otherwise.
// AUGMENT_SESSION_AUTH takes the JSON in ~/.augment/session.json.
const env: Record<string, string> = {};
for (const key of auggieAcp.inheritEnv ?? []) {
  const value = process.env[key];
  if (value) env[key] = value;
}
// What a scenario's CLI sees, so the sign-in check answers for the same CLI.
const scenarioEnv: Record<string, string> = {};
for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM']) {
  const value = process.env[key];
  if (value !== undefined) scenarioEnv[key] = value;
}

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const binaryPath = await findOnPath('auggie', process.env.PATH);
    if (!binaryPath) return 'the auggie binary is not on PATH';
    const status = await checkAcpSignIn(auggieAcp, {
      binaryPath,
      cwd: process.cwd(),
      env: { ...scenarioEnv, ...env },
    });
    if (status.status === 'authenticated') return null;
    return env.AUGMENT_SESSION_AUTH
      ? status.message
      : `${status.message} The suite's minimal environment may not reach ~/.augment (on Windows it never does): set AUGMENT_SESSION_AUTH to the contents of ~/.augment/session.json.`;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
