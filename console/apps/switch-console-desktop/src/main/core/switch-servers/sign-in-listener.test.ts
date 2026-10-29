import { expect, it, vi } from 'vitest';
import { vendorRefusal } from './sign-in-listener';

vi.mock('@main/app/window', () => ({ focusMainWindow: vi.fn() }));

// The same cases as Core's wording of a refusal (`test_sign_in_flows.py`).
it.each([
  ['access_denied', null, 'Example sign-in was cancelled.'],
  ['access_denied', '   ', 'Example sign-in was cancelled.'],
  ['', null, 'Example sign-in was cancelled.'],
  [
    'access_denied',
    'The user has denied your application access.',
    'Example refused the sign-in: The user has denied your application access.',
  ],
  [
    'server_error',
    'Your identity provider did not allow this app',
    'Example refused the sign-in: Your identity provider did not allow this app.',
  ],
  ['invalid_scope', null, 'Example refused the sign-in (invalid_scope).'],
  [
    'server_error',
    "<b>Blocked</b> by\n<a href='https://phish.example.test'>policy</a>‮!",
    'Example refused the sign-in: Blocked by policy !',
  ],
  ['<script>x</script>', null, 'Example refused the sign-in (x).'],
])('words %j with %j in the vendor’s words, without markup', (error, description, said) => {
  expect(vendorRefusal('Example', error, description).message).toBe(said);
});

it('sends on what it shows: the code and description without markup', () => {
  expect(vendorRefusal('Example', 'server_error', 'Denied <i>here</i>')).toEqual({
    error: 'server_error',
    description: 'Denied here',
    message: 'Example refused the sign-in: Denied here.',
  });
  expect(vendorRefusal('Example', 'access_denied', ' ').description).toBeNull();
});

it('cuts a long refusal short', () => {
  const said = vendorRefusal('Example', 'server_error', 'word '.repeat(200)).message;
  expect(said.startsWith('Example refused the sign-in: word word')).toBe(true);
  expect(said.endsWith('…')).toBe(true);
  expect(Array.from(said)).toHaveLength('Example refused the sign-in: '.length + 300);
});
