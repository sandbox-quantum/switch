import { describe, expect, it } from 'vitest';
import { attachmentFilename } from './attachment-filename';

describe('attachmentFilename', () => {
  it('shows a right-to-left override as a mark, so the real extension shows', () => {
    expect(attachmentFilename('invoice\u202Efdp.exe')).toBe('invoice_fdp.exe');
  });

  it('marks every bidi control, directional mark and hidden character', () => {
    for (const char of [
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\u200B',
      '\u200E',
      '\u200F',
      '\u2060',
      '\uFEFF',
    ])
      expect(attachmentFilename(`a${char}b.txt`)).toBe('a_b.txt');
  });

  it('keeps the zero-width joiner and non-joiner, which scripts and emoji need', () => {
    expect(attachmentFilename('family-\u{1F468}\u200D\u{1F469}.png')).toBe(
      'family-\u{1F468}\u200D\u{1F469}.png'
    );
    expect(attachmentFilename('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt')).toBe(
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.txt'
    );
  });

  it('turns a path into one name that is not hidden', () => {
    expect(attachmentFilename('../../../../../tmp/render-traversal.command')).toBe(
      '_.._.._.._.._tmp_render-traversal.command'
    );
    expect(attachmentFilename('C:\\Users\\x\\evil.lnk')).toBe('C__Users_x_evil.lnk');
    expect(attachmentFilename('.bashrc')).toBe('bashrc');
  });

  it('marks control characters and the characters Windows refuses', () => {
    expect(attachmentFilename('a\nb\u0007c\u0085d.txt')).toBe('a_b_c_d.txt');
    expect(attachmentFilename('what?<is>*this|".txt')).toBe('what__is__this__.txt');
  });

  it('leaves an ordinary name alone', () => {
    expect(attachmentFilename('Quarterly report (final).pdf')).toBe('Quarterly report (final).pdf');
  });

  it('names a file that is left with no name', () => {
    expect(attachmentFilename('...')).toBe('attachment');
    expect(attachmentFilename('')).toBe('attachment');
  });

  it('is unchanged by a second pass', () => {
    const once = attachmentFilename(' ..invoice\u202Efdp.exe. ');
    expect(attachmentFilename(once)).toBe(once);
  });
});
