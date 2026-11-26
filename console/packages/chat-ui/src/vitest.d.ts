import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import type { expect } from 'vitest';

declare module 'vitest' {
  interface Assertion<T = unknown> extends jest.Matchers<void, T>, TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining extends jest.Matchers<void, unknown> {}
}
