import { runLifecycleScriptWithPolicy } from './lifecycle-script-coordinator';
import { resolveLifecycleScript } from './lifecycle-script-settings';

export async function runLifecycleScript({
  locationId,
  sessionId,
  type,
}: {
  locationId: string;
  sessionId: string;
  type: 'setup' | 'run' | 'teardown';
}) {
  const { runtime, script, shellSetup } = await resolveLifecycleScript({
    locationId,
    type,
  });
  if (!script) return;
  await runLifecycleScriptWithPolicy({
    runtime,
    locationId,
    sessionId,
    type,
    script,
    shellSetup,
    origin: 'manual',
    policy: {
      respawnAfterExit: true,
      logFailure: true,
      surfaceFailure: true,
      continueOnFailure: false,
    },
    logPrefix: 'TerminalsController',
  });
}
