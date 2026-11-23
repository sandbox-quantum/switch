import { expect, it } from 'vitest';
import { adapterFor, startSchema } from './server';

it.each(['gemini', 'future-provider'])(
  'rejects unsupported execution provider %s explicitly',
  (provider) => {
    expect(() => adapterFor(provider, undefined, '', [])).toThrow(
      `Unsupported execution provider: ${provider}`
    );
    expect(startSchema.shape.provider.safeParse(provider).success).toBe(false);
  }
);

it.each(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])(
  'accepts the %s runtime mode in a start request',
  (runtimeMode) => {
    expect(startSchema.shape.input.shape.runtimeMode.safeParse(runtimeMode).success).toBe(true);
  }
);
