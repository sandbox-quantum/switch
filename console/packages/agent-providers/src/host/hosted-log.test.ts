import { expect, it } from 'vitest';
import { redactHostedText } from './hosted-log';

it('prefers the longest match when one secret is a prefix of another', () => {
  expect(redactHostedText('before abcdef after abc', ['abc', 'abcdef'])).toBe(
    'before [REDACTED] after [REDACTED]'
  );
});

it('redacts a UTF-8 secret and leaves text without secrets unchanged', () => {
  expect(redactHostedText('before tøk🔐en after', ['tøk🔐en'])).toBe('before [REDACTED] after');
  expect(redactHostedText('nothing here', [''])).toBe('nothing here');
});
