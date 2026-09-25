import { createRPCController } from '@shared/lib/ipc/rpc';
import { installIsEmpty } from './install-contents';

export const onboardingController = createRPCController({
  installIsEmpty,
});
