import { describe, expect, it } from 'vitest';
import { plugin } from './index';

describe('OpenHands installation', () => {
  it.each(['macos', 'linux'] as const)(
    'offers the Python distribution required by the launcher on %s',
    (platform) => {
      const options = plugin.capabilities.hostDependency.installCommands[platform];
      expect(options).toEqual([
        {
          method: 'other',
          label: 'uv (Python 3.12)',
          command: 'uv tool install --python 3.12 openhands==1.16.0',
        },
      ]);
    }
  );

  it('does not offer updates that could replace the version-gated CLI', () => {
    expect(plugin.capabilities.hostDependency.updates).toEqual({ kind: 'none' });
  });
});
