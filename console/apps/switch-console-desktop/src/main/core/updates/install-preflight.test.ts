import { describe, expect, it } from 'vitest';
import { isTranslocated } from './install-preflight';

describe('isTranslocated', () => {
  it('finds an app that Gatekeeper runs from a randomised mount', () => {
    expect(
      isTranslocated(
        '/private/var/folders/x/T/AppTranslocation/1A2B/d/Switch Console.app/Contents/MacOS/Switch Console'
      )
    ).toBe(true);
  });

  it('passes an app in the Applications folder', () => {
    expect(isTranslocated('/Applications/Switch Console.app/Contents/MacOS/Switch Console')).toBe(
      false
    );
  });

  it('passes an app run from a user folder', () => {
    expect(
      isTranslocated('/Users/me/Downloads/Switch Console.app/Contents/MacOS/Switch Console')
    ).toBe(false);
  });
});
