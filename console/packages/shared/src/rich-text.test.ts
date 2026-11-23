import { describe, expect, it } from 'vitest';
import { bold, code, plainText, rich } from './rich-text';

describe('rich', () => {
  it('turns a template into spans, plain values as plain text', () => {
    expect(rich`found ${2} at ${code('/bin/x')}`).toEqual([
      { text: 'found ' },
      { text: '2' },
      { text: ' at ' },
      { text: '/bin/x', code: true },
    ]);
  });

  it('splices in other rich text and drops empty spans', () => {
    const inner = rich`${bold('a')} b`;
    expect(rich`${inner}${code('c')}`).toEqual([
      { text: 'a', bold: true },
      { text: ' b' },
      { text: 'c', code: true },
    ]);
  });
});

describe('plainText', () => {
  it('joins the text of every span', () => {
    expect(plainText(rich`found at ${code('/bin/x')}`)).toBe('found at /bin/x');
  });
});
