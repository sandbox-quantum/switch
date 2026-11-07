import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AMP_APPROVAL_PLUGIN_SOURCE,
  AMP_PLUGIN_ENDPOINT_VARIABLE,
  AMP_PLUGIN_TOKEN_VARIABLE,
} from './approval-plugin';

describe('the Amp approval plugin source', () => {
  it('is a syntactically valid ES module that handles the events the adapter relies on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amp-plugin-'));
    try {
      const path = join(dir, 'plugin.mjs');
      await writeFile(path, AMP_APPROVAL_PLUGIN_SOURCE);
      const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      expect(check.stderr).toBe('');
      expect(check.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    for (const event of ['session.start', 'agent.start', 'agent.end', 'tool.call'])
      expect(AMP_APPROVAL_PLUGIN_SOURCE).toContain(`amp.on('${event}'`);
    expect(AMP_APPROVAL_PLUGIN_SOURCE).toContain(`process.env.${AMP_PLUGIN_ENDPOINT_VARIABLE}`);
    expect(AMP_APPROVAL_PLUGIN_SOURCE).toContain(`process.env.${AMP_PLUGIN_TOKEN_VARIABLE}`);
  });

  it('does nothing without the adapter’s endpoint, so a stray copy is inert', () => {
    expect(AMP_APPROVAL_PLUGIN_SOURCE).toContain('if (!endpoint || !token) return');
  });

  it('refuses a tool when Switch cannot be reached rather than letting it run', () => {
    expect(AMP_APPROVAL_PLUGIN_SOURCE).toMatch(
      /catch \(error\) \{\s*return \{ action: 'reject-and-continue'/
    );
  });
});
