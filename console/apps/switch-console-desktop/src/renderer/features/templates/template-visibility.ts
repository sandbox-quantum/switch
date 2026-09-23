import type { TemplateVisibility } from '@main/core/switch-servers/gateway-client';

/** The three settings a template can have, as one choice rather than two flags. */
export type TemplateAccess = 'shared' | 'open' | 'private';

export const TEMPLATE_ACCESS_OPTIONS: { value: TemplateAccess; label: string; hint: string }[] = [
  {
    value: 'shared',
    label: 'Shared',
    hint: 'Everyone on the workspace can use it. You change it.',
  },
  { value: 'open', label: 'Open', hint: 'Everyone on the workspace can use it and change it.' },
  { value: 'private', label: 'Private', hint: 'Only you and admins can see it.' },
];

export function accessOf(t: {
  readVisibility: TemplateVisibility;
  writeVisibility: TemplateVisibility;
}): TemplateAccess {
  if (t.readVisibility === 'private') return 'private';
  return t.writeVisibility === 'public' ? 'open' : 'shared';
}

export function visibilityOf(access: TemplateAccess): {
  readVisibility: TemplateVisibility;
  writeVisibility: TemplateVisibility;
} {
  return {
    readVisibility: access === 'private' ? 'private' : 'public',
    writeVisibility: access === 'open' ? 'public' : 'private',
  };
}

export function accessLine(access: TemplateAccess): string {
  return access === 'private'
    ? 'Only you and admins can see it'
    : access === 'open'
      ? 'Shared with the workspace, anyone can edit it'
      : 'Shared with the workspace';
}
