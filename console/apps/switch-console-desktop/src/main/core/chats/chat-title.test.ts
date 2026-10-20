import { describe, expect, it } from 'vitest';
import { chatTitleFrom } from './chat-title';

describe('chatTitleFrom', () => {
  it('keeps a plain title', () => {
    expect(chatTitleFrom('Nightly build failure on ARM runners\n')).toBe(
      'Nightly build failure on ARM runners'
    );
  });

  it('strips quotes, a label and closing punctuation', () => {
    expect(chatTitleFrom('  "Fix the login bug."  ')).toBe('Fix the login bug');
    expect(chatTitleFrom('Title: «Revisar el despliegue»')).toBe('Revisar el despliegue');
  });

  it('takes the first line only', () => {
    expect(chatTitleFrom('Deploy checklist\nHere is why I chose it')).toBe('Deploy checklist');
  });

  it('caps the length at 60 characters', () => {
    expect(chatTitleFrom('word '.repeat(30))).toHaveLength(59);
  });
});
