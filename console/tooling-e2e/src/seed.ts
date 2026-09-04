/**
 * Phase one of a provider-session run: register the throwaway agent, create its
 * room and channel, write its credentials into the working directory, and
 * record all of it in `SWITCH_E2E_MANIFEST`.
 *
 * It exists because the order is forced. Switch Console can only start a session
 * for an agent that is already in its database, and it reads that database at
 * launch — so the agent has to exist before the console starts, and the console
 * has to be up before the first scenario posts. Splitting setup out gives the
 * three steps somewhere to happen in:
 *
 *     SWITCH_E2E=1 SWITCH_E2E_MANIFEST=… SWITCH_E2E_AGENT_DIR=… \
 *       node --experimental-strip-types src/seed.ts
 *     # seed the console's database from the manifest, start the console
 *     SWITCH_E2E=1 SWITCH_E2E_MANIFEST=… … vitest run src/run.integration.test.ts
 *
 * The scenario run finds the manifest, reuses what is in it rather than
 * registering a second agent, and deletes it during teardown.
 */
import { loadEnv } from './env.ts';
import { setupHarness } from './harness.ts';

export async function seed(log: (message: string) => void = console.log): Promise<void> {
  const env = loadEnv();
  if (!env.manifestPath) {
    throw new Error('SWITCH_E2E_MANIFEST must name the file to record the agent and room in.');
  }
  const harness = await setupHarness(env);
  log(
    [
      `agent    ${harness.agent.name} (${harness.agent.id})`,
      `bot      @${harness.bot.username} (${harness.bot.id})`,
      `channel  ${harness.channel.name} (${harness.channel.id})`,
      `room     ${harness.room.name} (${harness.room.id})`,
      `manifest ${env.manifestPath}`,
    ].join('\n')
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
