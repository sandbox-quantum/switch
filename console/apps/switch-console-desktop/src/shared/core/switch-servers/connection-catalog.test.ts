import { expect, it } from 'vitest';
import { serviceKeyFieldSchema } from './connection-catalog';

const field = { name: 'site', label: 'Site', secret: false, help: null };

it('keeps choice fields from older servers compatible', () => {
  const parsed = serviceKeyFieldSchema.parse({ ...field, choices: ['example.test'] });
  expect(parsed.choices).toEqual(['example.test']);
  expect(parsed.pattern).toBeUndefined();
});

it('preserves the bounded identifier pattern supplied by Core', () => {
  const pattern = '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$';
  expect(serviceKeyFieldSchema.parse({ ...field, choices: null, pattern }).pattern).toBe(pattern);
});
