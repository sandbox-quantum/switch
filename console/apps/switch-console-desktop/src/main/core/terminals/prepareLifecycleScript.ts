import { resolveLifecycleScript } from './lifecycle-script-settings';

export async function prepareLifecycleScript({
  locationId,
  type,
}: {
  locationId: string;
  type: 'setup' | 'run' | 'teardown';
}): Promise<void> {
  const { runtime, script, shellSetup } = await resolveLifecycleScript({
    locationId,
    type,
  });
  if (!script) return;

  await runtime.lifecycleService.prepareLifecycleScript({
    type,
    script,
    shellSetup,
  });
}
