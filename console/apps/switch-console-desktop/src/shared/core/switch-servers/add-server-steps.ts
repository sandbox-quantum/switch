/**
 * The steps of the add-server wizard, and the path chosen at its first screen.
 *
 * Named here rather than in the modal because where people stop is reported
 * from the main process, which cannot import a React component. The modal
 * asserts at compile time that its own step union is exactly this list.
 */
export const ADD_SERVER_STEPS = [
  'choose',
  'local',
  'remoteHost',
  'external',
  'signIn',
  'linkAccounts',
] as const;

export type AddServerStepName = (typeof ADD_SERVER_STEPS)[number];

/**
 * Which kind of server the wizard is setting up.
 *
 * `none` is the first screen, where nothing has been chosen yet — so a drop-off
 * before choosing is distinguishable from one after.
 */
export const ADD_SERVER_CHOICES = ['none', 'local', 'remoteHost', 'external'] as const;

export type AddServerChoiceName = (typeof ADD_SERVER_CHOICES)[number];
