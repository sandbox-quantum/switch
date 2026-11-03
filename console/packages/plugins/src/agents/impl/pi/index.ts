import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

/**
 * Pi, pinned to the one release Switch runs (any other version is refused
 * when it starts and in the sign-in check). Updates re-run the pinned install
 * and look up no newer release, so Console never suggests one Switch would
 * refuse.
 */
const PI_HOST_DEPENDENCY = (() => {
  const base = npmDependency({
    id: 'pi',
    package: '@earendil-works/pi-coding-agent',
    versionSuffix: '@1.4.0',
    // Offline, as every Pi Switch starts: no update check, no telemetry.
    versionArgs: ['--version', '--offline'],
  });
  return {
    ...base,
    updates: {
      kind: 'supported' as const,
      releaseSource: { kind: 'none' as const },
      update: { kind: 'package-manager' as const },
    },
  };
})();

export const plugin = definePlugin(
  {
    id: 'pi',
    name: 'Pi',
    description:
      'Pi coding agent over its RPC mode, with approvals from the chat and resumable conversations.',
    websiteUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    cliLabel: 'Pi',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: PI_HOST_DEPENDENCY,
    mcp: {
      kind: 'none',
    },
    models: {
      kind: 'none',
    },
    plugins: {
      kind: 'none',
    },
    prompt: {
      kind: 'none',
    },
    sessions: {
      kind: 'resumable',
    },
    repoAgents: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Pi runs through the session host.');
    },
  },
});
