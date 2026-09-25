#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { OBSOLETE_BUNDLE_EXIT_CODE, WorkerObsoleteError } from './exit-codes';
import { runHostedBootstrap } from './hosted-bootstrap';
import { runGitHubCli, runGitHubCredentialHelper } from './hosted-github';
import { checkHostedPreflight } from './hosted-preflight';
import { superviseSharedHost } from './supervisor';
import { runCredentialVerification } from './verify-credential';

async function main(): Promise<void> {
  if (process.argv[2] === '--verify-credential') {
    await runCredentialVerification();
    return;
  }
  if (process.argv[2] === '--preflight-check') {
    const [stateDirectory, scratchDirectory, ...rest] = process.argv.slice(3);
    if (!stateDirectory || !scratchDirectory || rest.length)
      throw new Error(
        'Usage: switch-hosted-bootstrap --preflight-check <absolute-state-directory> <absolute-scratch-directory>'
      );
    const result = await checkHostedPreflight(stateDirectory, scratchDirectory);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if ('blocked' in result) process.exitCode = 2;
    return;
  }
  if (process.argv[2] === '--github-cli') {
    await runGitHubCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === '--git-credential') {
    if (process.argv.length !== 4) throw new Error('Invalid Git credential helper arguments.');
    await runGitHubCredentialHelper(process.argv[3]);
    return;
  }
  const [stateDirectory, specPath, ...extra] = process.argv.slice(2);
  if (!stateDirectory || !specPath || extra.length)
    throw new Error(
      'Usage: switch-hosted-bootstrap <absolute-state-directory> <deployment-spec.json>'
    );
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    await runHostedBootstrap(
      {
        stateDirectory,
        specPath,
        sharedDaemonEntrypoint: fileURLToPath(new URL('./shared-host-daemon.mjs', import.meta.url)),
        signal: stop.signal,
      },
      { supervise: superviseSharedHost }
    );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Hosted SDK bootstrap failed.');
  process.exitCode = error instanceof WorkerObsoleteError ? OBSOLETE_BUNDLE_EXIT_CODE : 1;
});
