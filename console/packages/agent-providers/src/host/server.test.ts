import { expect, it } from 'vitest';
import { adapterFor, startSchema } from './server';

it.each(['gemini', 'future-provider'])(
  'rejects unsupported execution provider %s explicitly',
  (provider) => {
    expect(() => adapterFor(provider)).toThrow(`Unsupported execution provider: ${provider}`);
    expect(startSchema.shape.provider.safeParse(provider).success).toBe(false);
  }
);
