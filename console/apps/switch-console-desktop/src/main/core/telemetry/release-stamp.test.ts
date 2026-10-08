import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A packaged build reports its usage to production's Amplitude project only
 * when the release workflow stamped it `VITE_RELEASE=1`; anything else reports
 * to dev's. So a release whose build step lost the stamp would file every real
 * user under dev, with nothing anywhere reporting a fault. This holds the
 * workflow to stamping every build step, and only on a tag.
 */
const workflow = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../../.github/workflows/switch-console-release.yml'
  ),
  'utf8'
);

describe('the release workflow', () => {
  it('stamps every build step that sets the channel', () => {
    const buildSteps = workflow.match(/^\s+VITE_BUILD: .*$/gm) ?? [];
    const stamps = workflow.match(
      /^\s+VITE_RELEASE: \$\{\{ needs\.resolve\.outputs\.vite_release \}\}$/gm
    );

    expect(buildSteps.length).toBeGreaterThan(0);
    expect(stamps?.length).toBe(buildSteps.length);
  });

  it('marks a build a release on a tag and on nothing else', () => {
    expect(workflow).toMatch(/refs\/tags\/\*\) vite_release=1 ;;/);
    expect(workflow).toMatch(/\*\) vite_release= ;;/);
    expect(workflow).toMatch(/echo "vite_release=\$vite_release"/);
  });
});
