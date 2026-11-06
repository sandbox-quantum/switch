import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { PEOPLE_WORDS } from './people-words';
import type { YourCloudView } from './your-cloud';

const W = PEOPLE_WORDS.checklist;

export type ChecklistLine =
  | {
      key: 'cloud';
      done: boolean;
      text: string;
      action: { kind: 'start'; how: 'ensure' | 'lifecycle' } | null;
    }
  | {
      key: 'login';
      done: boolean;
      text: string;
      action: { kind: 'give_login'; provider: string } | null;
    }
  | { key: 'agent'; done: boolean; text: string; action: { kind: 'add_agent' } | null };

/** The provider a box is offered a login for first: the first one it reports not ready, else Claude. */
function providerToGive(machine: OwnedMachine): string {
  return machine.providers.find((provider) => !provider.ready)?.provider ?? 'claude';
}

function listsProvider(machine: OwnedMachine, provider: string): boolean {
  return machine.providers.some((entry) => entry.provider === provider);
}

function readyOn(machine: OwnedMachine, provider: string): boolean {
  return machine.providers.some((entry) => entry.provider === provider && entry.ready);
}

/**
 * Your cloud's setup checklist (the PM's rules, the same as Switch web):
 *  1. "Your cloud is ready", or "Your cloud is stopped" with Start. A resting
 *     box counts as ready. Paused, turned off, starting or stopping show the
 *     card's own heading and line, with no button.
 *  2. "AI login set", or "No AI login yet" with Give login. With no agent
 *     yet, set when any provider on the box's controller is ready (installed
 *     and logged in). With agents, set only when every provider they use is
 *     ready there, and Give login opens the first one that's missing. A
 *     provider the box doesn't list is left out, since no login helps it.
 *  3. "First agent added", or "No agent yet" with Add agent.
 * Null once all three are ticked (it folds away), and null while the login
 * state isn't known yet, so it never flashes a wrong "No AI login yet".
 */
export function setupChecklist(params: {
  view: YourCloudView;
  agents: readonly string[];
  /** The box's controller as the machine list reports it; undefined while that list loads. */
  controller: OwnedMachine | null | undefined;
  /**
   * The providers the box's agents use: undefined while the agent list loads,
   * null when it can't be read (then any ready provider counts, as with no agents).
   */
  agentProviders: readonly string[] | null | undefined;
}): ChecklistLine[] | null {
  // No default: undefined means the agent list is still loading, and must wait.
  const { view, agents, controller, agentProviders } = params;
  if (controller === undefined) return null;
  if (agents.length > 0 && agentProviders === undefined) return null;
  const cloud: ChecklistLine = !view.resting
    ? { key: 'cloud', done: true, text: W.cloudReady, action: null }
    : view.heading === 'Resting'
      ? { key: 'cloud', done: true, text: W.cloudReady, action: null }
      : view.heading === 'Stopped'
        ? {
            key: 'cloud',
            done: false,
            text: W.cloudStopped,
            action: view.start ? { kind: 'start', how: view.start } : null,
          }
        : { key: 'cloud', done: false, text: `${view.heading} · ${view.line}`, action: null };
  // An agent on a provider the box doesn't list (unknown, or one it takes no login for) is
  // left out: no login would help it, so it neither blocks the tick nor gets Give login.
  const listed =
    controller && agents.length > 0 && agentProviders
      ? agentProviders.filter((provider) => listsProvider(controller, provider))
      : [];
  const needed = listed.length > 0 ? listed : null;
  const missing =
    needed && controller ? needed.filter((provider) => !readyOn(controller, provider)) : [];
  const loginSet =
    controller !== null &&
    (needed ? missing.length === 0 : controller.providers.some((provider) => provider.ready));
  const login: ChecklistLine = loginSet
    ? { key: 'login', done: true, text: W.loginSet, action: null }
    : {
        key: 'login',
        done: false,
        text: W.loginMissing,
        // No controller row yet (a box still enrolling), or one that can't take a sealed
        // login: there's nothing to give a login to from here.
        action:
          controller && controller.acceptsLogins
            ? { kind: 'give_login', provider: missing[0] ?? providerToGive(controller) }
            : null,
      };
  const agent: ChecklistLine =
    agents.length > 0
      ? { key: 'agent', done: true, text: W.agentAdded, action: null }
      : { key: 'agent', done: false, text: W.agentMissing, action: { kind: 'add_agent' } };
  const lines = [cloud, login, agent];
  return lines.every((line) => line.done) ? null : lines;
}
