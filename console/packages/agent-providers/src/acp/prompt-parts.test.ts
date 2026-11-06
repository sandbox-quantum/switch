import { expect, it } from 'vitest';
import { promptParts } from './prompt-parts';

it('refuses an attachment that cannot fit before returning any partial message', () => {
  expect(() =>
    promptParts('s', 'instructions', [{ type: 'image', data: 'x'.repeat(2000) }], 1000)
  ).toThrow('Attachment exceeds');
});

it('keeps a short message and its attachments in their original single request', () => {
  const image = { type: 'image', data: 'abc' };
  expect(promptParts('s', 'hello', [image], 65536)).toEqual([
    [{ type: 'text', text: 'hello' }, image],
  ]);
});
