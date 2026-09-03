import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';
import { HOOK_EVENTS } from './hooks-types';
import type { CanonicalHookEvent, HookCommandOptions, HookRegistration } from './hooks-types';

export type { HookRegistration };
export type {
  CanonicalHookEvent,
  HookCommand,
  HookCommandOptions,
  HookEvent,
  NotificationType,
} from './hooks-types';
export { HOOK_EVENTS } from './hooks-types';

export type IHooksBehavior = {
  readHooks(fs: PluginFs): Promise<HookRegistration[]>;
  /**
   * Write hooks for a session that will run on `opts.platform`, and return the
   * root-relative paths written. The platform is the target host's, which is
   * not Switch Console's whenever the session is remote.
   */
  writeHooks(fs: PluginFs, hooks: HookRegistration[], opts: HookCommandOptions): Promise<string[]>;
  deleteHooks(fs: PluginFs): Promise<void>;
  getHooksInstalled(fs: PluginFs): Promise<boolean>;
  /**
   * Parse a raw hook event (event type header + JSON body) into a canonical form.
   * Optional — the desktop falls back to defaultHookEventParser when absent.
   */
  parseHookEvent?(eventType: string, body: Record<string, unknown>): CanonicalHookEvent;
};

/**
 * hooksDescriptor is used to describe the hooks that an agent supports.
 *
 * kind: 'config'  — hooks written into agent config file(s)
 * kind: 'plugin'  — hooks delivered via a dropped file/plugin
 * kind: 'none'    — agent does not support lifecycle hooks
 */
export const hooksCapability = definePluginCapability<IHooksBehavior>()(
  'hooks',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('config'),
      scope: z.enum(['global', 'workspace']),
      supportedEvents: z.array(z.enum(HOOK_EVENTS)),
      /**
       * Whether the agent fires a hook when its session comes up, before any
       * turn. That signal is what tells Switch Console a spawned session is
       * really running rather than parked on a first-run prompt it has nobody
       * to answer; without it a stalled session is indistinguishable from a
       * working one. Only set this where the hook has been observed firing on
       * a real spawn.
       */
      reportsSessionStart: z.boolean(),
    }),
    z.object({
      kind: z.literal('plugin'),
      scope: z.enum(['global', 'workspace']),
      supportedEvents: z.array(z.enum(HOOK_EVENTS)),
      /**
       * Whether the agent fires a hook when its session comes up, before any
       * turn. That signal is what tells Switch Console a spawned session is
       * really running rather than parked on a first-run prompt it has nobody
       * to answer; without it a stalled session is indistinguishable from a
       * working one. Only set this where the hook has been observed firing on
       * a real spawn.
       */
      reportsSessionStart: z.boolean(),
    }),
    z.object({ kind: z.literal('none') }),
  ])
);
