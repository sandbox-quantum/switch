import { describe, expect, it, vi } from 'vitest';
import { openCodeLoginCommand } from './local-opencode-sign-in';
vi.mock('@main/core/agent-runtime/impl/resolve-agent-executable', () => ({}));
vi.mock('@main/core/dependencies/dependency-managers', () => ({}));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({}));
vi.mock('@main/core/execution-context/local-execution-context', () => ({}));

describe('OpenCode login instructions', () => {
  it.each([
    ['1.18.32', 'opencode console login [url]', 'opencode console login'],
    ['1.2.0', 'opencode [project]', 'opencode auth login'],
    ['2.0.0', '', 'opencode auth login opencode'],
    ['2.0.0-beta.1', 'opencode console login [url]', 'opencode auth login opencode'],
  ])('chooses the supported command for %s', (version, help, expected) => {
    expect(openCodeLoginCommand(version, help)).toBe(expected);
  });
});
