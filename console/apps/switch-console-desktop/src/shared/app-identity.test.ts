import { afterEach, describe, expect, it, vi } from 'vitest';

// A test build's label ("Hosted Agents v2 · 0.0.6") is shown only: the window
// title, the About box and the download's file name. The names that key
// macOS registration, the keychain and the data folder never move with it.

async function identity(label?: string) {
  vi.resetModules();
  if (label === undefined) vi.stubEnv('VITE_BUILD_LABEL', '');
  else vi.stubEnv('VITE_BUILD_LABEL', label);
  return import('./app-identity');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the build label', () => {
  it('when set, shows in the window title and the download name', async () => {
    const id = await identity('Hosted Agents v2 · 0.0.6');
    expect(id.BUILD_LABEL).toBe('Hosted Agents v2 · 0.0.6');
    expect(id.WINDOW_TITLE).toBe('Switch Console — Hosted Agents v2 · 0.0.6');
    expect(id.ARTIFACT_NAME_PREFIX).toBe('switch-console-hosted-agents-v2-0.0.6');
    // So the macOS download is switch-console-hosted-agents-v2-0.0.6-arm64.dmg.
    expect(`${id.ARTIFACT_NAME_PREFIX}-arm64.dmg`).toBe(
      'switch-console-hosted-agents-v2-0.0.6-arm64.dmg'
    );
  });

  it('when empty, nothing changes', async () => {
    const id = await identity();
    expect(id.BUILD_LABEL).toBe('');
    expect(id.WINDOW_TITLE).toBe(id.PRODUCT_NAME);
    expect(id.ARTIFACT_NAME_PREFIX).toBe(id.ARTIFACT_PREFIX);
  });

  it('never moves the names that hold sign-ins and data, labelled or not', async () => {
    for (const label of [undefined, 'Hosted Agents v2 · 0.0.6']) {
      const id = await identity(label);
      expect(id.APP_ID).toBe('com.switchdash.stable');
      expect(id.PRODUCT_NAME).toBe('Switch Console');
      expect(id.OS_APP_NAME).toBe('Switchdash');
      expect(['switchdash', 'switchdash-dev']).toContain(id.USER_DATA_DIR_NAME);
      expect(id.ARTIFACT_PREFIX).toBe('switch-console');
    }
  });

  it('keeps to plain characters and a sane length; anything else gives no label', async () => {
    const { cleanBuildLabel, buildLabelSlug } = await identity();
    expect(cleanBuildLabel('  Hosted Agents v2 · 0.0.6  ')).toBe('Hosted Agents v2 · 0.0.6');
    expect(cleanBuildLabel('<script>')).toBe('');
    expect(cleanBuildLabel('../../evil')).toBe('');
    expect(cleanBuildLabel('x'.repeat(41))).toBe('');
    expect(cleanBuildLabel(undefined)).toBe('');
    expect(buildLabelSlug('Hosted Agents v2 · 0.0.6')).toBe('hosted-agents-v2-0.0.6');
    expect(buildLabelSlug('Pilot (build 7)')).toBe('pilot-build-7');
  });
});
