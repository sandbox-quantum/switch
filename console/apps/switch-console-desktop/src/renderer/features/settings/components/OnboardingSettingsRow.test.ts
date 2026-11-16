import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const build = vi.hoisted(() => ({ onboarding: true }));
vi.mock('@shared/core/feature-flags/feature-flags', () => ({ BUILD_FEATURE_FLAGS: build }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { showChecklist: true },
    update: () => {},
    isLoading: false,
    isSaving: false,
    isFieldOverridden: () => false,
    resetField: () => {},
  }),
}));

const { OnboardingChecklistRow } = await import('./OnboardingSettingsRow');

const render = () => renderToStaticMarkup(React.createElement(OnboardingChecklistRow));

beforeEach(() => {
  build.onboarding = true;
});

it('offers no checklist switch in a build whose sidebar cannot show the checklist', () => {
  expect(render()).toBe('');
});

it('offers the switch where the sidebar shows the checklist', () => {
  build.onboarding = false;
  expect(render()).toContain('Onboarding checklist');
});
