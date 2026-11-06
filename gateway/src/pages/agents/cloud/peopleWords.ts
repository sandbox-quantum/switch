// The words people read about their own cloud on Switch web (hosted agents v2,
// UX pass): the setup checklist, each agent's next step, the empty states and
// the resting explanation. Switch Console's hosted summary uses the same
// strings (the two apps can't share code, so Console keeps a copy). Change
// both together. Wording from the PM's "Exact strings (people)" table in the stories.

import type { CloudMachine } from "../../../data/hostedCloud";
import { startBlocked, yourCloudView } from "./yourCloud";

/** A resting box with agents, wherever it shows (proposal item 7). */
export const RESTING_EXPLANATION =
  "Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.";

/** Empty states, each with its next step (proposal item 5). */
export const EMPTY = {
  noAgents: "Add your first agent on Switch cloud",
  noLogin: "Give your agent a login so it can answer",
  noFiles: "Your agents' files appear here once they make something",
} as const;

export type SetupStep = "cloud" | "login" | "agent";

/** The setup checklist's lines (proposal item 1): ticked, not yet, and the button. */
export const SETUP_WORDS: Record<SetupStep, { done: string; todo: string; action: string }> = {
  cloud: { done: "Your cloud is ready", todo: "Your cloud is stopped", action: "Start" },
  login: { done: "AI login set", todo: "No AI login yet", action: "Give login" },
  agent: { done: "First agent added", todo: "No agent yet", action: "Add agent" },
};

export interface SetupLine {
  step: SetupStep;
  done: boolean;
  text: string;
  /** The button on an unticked line; absent when nothing the person can press would help. */
  action?: string;
  /** With no button, the panel's own line under its heading (a paused or starting box). */
  note?: string;
}

/**
 * The setup checklist, or null once all three are ticked (it folds away).
 * The cloud counts as ready while it's up or resting: a resting box is set up
 * and wakes by itself. A login counts once the box has confirmed one
 * (`loginSet`), as "Login set" does.
 */
export function setupChecklist(
  machine: Parameters<typeof yourCloudView>[0] & Pick<CloudMachine, "stop_reason">,
  loginSet: boolean,
): SetupLine[] | null {
  const cloud = yourCloudView(machine, () => "");
  const cloudReady = !cloud.resting || cloud.heading === "Resting";
  const lines: SetupLine[] = [
    cloudReady
      ? { step: "cloud", done: true, text: SETUP_WORDS.cloud.done }
      : cloud.resting && cloud.start && !startBlocked(machine)
        ? { step: "cloud", done: false, text: SETUP_WORDS.cloud.todo, action: SETUP_WORDS.cloud.action }
        : // No button: the panel's own state says why ("Starting…", "Paused by Switch").
          { step: "cloud", done: false, text: cloud.heading, note: cloud.resting ? cloud.line : undefined },
    loginSet
      ? { step: "login", done: true, text: SETUP_WORDS.login.done }
      : { step: "login", done: false, text: SETUP_WORDS.login.todo, action: SETUP_WORDS.login.action },
    machine.agents.length > 0
      ? { step: "agent", done: true, text: SETUP_WORDS.agent.done }
      : { step: "agent", done: false, text: SETUP_WORDS.agent.todo, action: SETUP_WORDS.agent.action },
  ];
  return lines.every((line) => line.done) ? null : lines;
}

/** What a status line's next step does: its second part becomes a link that
 * goes there ("Can't reply right now · Check your AI login" opens the AI logins). */
export type NextAction = "give_login";
