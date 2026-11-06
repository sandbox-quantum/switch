import { type SwitchApiKey } from '@shared/core/switch-servers/switch-servers';

/** Registration keys first, then agent keys; anything else is not the person's to manage here. */
export function splitApiKeys(keys: readonly SwitchApiKey[]): {
  registration: SwitchApiKey[];
  agent: SwitchApiKey[];
} {
  return {
    registration: keys.filter((key) => key.type === 'registration' || key.type === 'bootstrap'),
    agent: keys.filter((key) => key.type === 'agent'),
  };
}
