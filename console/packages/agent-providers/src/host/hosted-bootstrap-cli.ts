#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runHostedBootstrap } from './hosted-bootstrap';

async function main(): Promise<void> {
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
    await runHostedBootstrap({
      stateDirectory,
      specPath,
      sharedDaemonEntrypoint: fileURLToPath(new URL('./shared-host-daemon.mjs', import.meta.url)),
      signal: stop.signal,
    });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Hosted SDK bootstrap failed.');
  process.exitCode = 1;
});
