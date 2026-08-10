import type { PluginFs } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

function createMemoryFs(): PluginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async delete(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(path) {
      return [...files.keys()].filter((file) => file.startsWith(path));
    },
  };
}

describe('kilocode plugin hooks', () => {
  it('installs the Switch Console notifications plugin into the Kilo workspace plugin path', async () => {
    const fs = createMemoryFs();

    const written = await provider.behavior.plugins?.installPlugin(fs, {
      kind: 'workspace',
      path: '/workspace',
    });

    expect(written).toEqual(['.kilo/plugins/switchdash-notifications.js']);
    const content = await fs.read('.kilo/plugins/switchdash-notifications.js');
    expect(content).toContain('export const SwitchdashNotifications');
    expect(content).toContain('X-Switchdash-Event-Type');
    expect(content).toContain("event.type === 'session.idle'");
    expect(content).toContain("event.type === 'session.error'");
    expect(content).toContain('getKiloSessionId');
  });
});
