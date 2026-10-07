#!/usr/bin/env node
import { runGitHubCli, runGitHubCredentialHelper } from './hosted-github';

async function main(): Promise<void> {
  if (process.argv[2] === '--github-cli') {
    await runGitHubCli(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === '--git-credential') {
    if (process.argv.length !== 4) throw new Error('Invalid Git credential helper arguments.');
    await runGitHubCredentialHelper(process.argv[3]);
    return;
  }
  throw new Error(
    'Usage: switch-hosted-bootstrap --git-credential <operation> | --github-cli <arguments>'
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Hosted SDK bootstrap failed.');
  process.exitCode = 1;
});
