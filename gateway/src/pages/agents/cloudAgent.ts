import type { CloudMachine } from "../../data/hostedCloud";
import type { Controller, Definition, DesiredState, Provider, ProviderInfo } from "../../data/management";

/** How an agent is named: what rooms address it by. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The logins a box takes, by provider: only those its provider gateway fronts
 * (`gatewayPlanFor` in `console/packages/agent-controller-box/src/gateway-logins.ts`).
 * A box refuses every other login, so a cloud agent is offered only these
 * providers, and the login step only these kinds (security).
 */
export const BOX_LOGINS: Readonly<Record<string, readonly ("api-key" | "setup-token" | "vertex")[]>> = {
  claude: ["setup-token", "api-key", "vertex"],
  codex: ["api-key"],
};

/** The server's providers a cloud agent can use: those a box takes a login for, in the server's order. */
export function cloudProviders(providers: readonly ProviderInfo[]): ProviderInfo[] {
  return (Array.isArray(providers) ? providers : []).filter((provider) => Object.hasOwn(BOX_LOGINS, provider.id));
}

/**
 * Where a new cloud agent can go, from the person's box and their machines:
 * only the controller the box enrolled as (`controller_id`), never one picked
 * from the machines list by its kind, which also holds their own computers.
 */
export type BoxPlacement =
  | { kind: "ready"; controllerId: string }
  | { kind: "starting" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

export function boxPlacement(
  machine: CloudMachine | null,
  controllers: readonly Controller[],
): BoxPlacement {
  if (machine === null) return { kind: "starting" };
  // A v2 box only: an agent is never put on a v1 cloud machine from here.
  if (machine.backend !== "box")
    return { kind: "error", message: "Your cloud machine isn't a Switch cloud box, so an agent can't be added to it here." };
  if (machine.state === "error")
    return {
      kind: "error",
      message: machine.error ?? "Your Switch cloud couldn't start. Try again from Your cloud.",
    };
  // A box its owner stopped (or one Switch paused or turned off, which reads the
  // same here): asking for it again leaves it stopped, so say where to start it.
  if (machine.desired_state === "stopped" && !machine.sleeping && machine.stop_reason === "owner")
    return { kind: "stopped" };
  const controller =
    machine.controller_id === null
      ? undefined
      : controllers.find((candidate) => candidate.id === machine.controller_id);
  if (!controller || controller.revoked_at !== null || controller.state !== "online")
    return { kind: "starting" };
  return { kind: "ready", controllerId: controller.id };
}

export interface CloudAgentForm {
  name: string;
  description: string;
  provider: Provider;
  model: string;
  instructions: string;
}

export function cloudAgentFormValid(form: CloudAgentForm): boolean {
  return (
    AGENT_NAME_PATTERN.test(form.name) &&
    form.name.length <= 255 &&
    form.description.trim() !== "" &&
    form.provider !== ""
  );
}

/** The create request for an agent on the box's controller: isolated, as every cloud agent runs. */
export function cloudAgentRequest(
  form: CloudAgentForm,
  controllerId: string,
): {
  name: string;
  description: string;
  display_name: null;
  controller_id: string;
  desired_state: DesiredState;
  definition: Definition;
} {
  return {
    name: form.name,
    description: form.description.trim(),
    display_name: null,
    controller_id: controllerId,
    desired_state: "running",
    definition: {
      provider: form.provider,
      model: form.model.trim() || null,
      instructions: form.instructions,
      auto_mode: true,
      auto_approve: false,
      directory: null,
      isolation: "isolated",
      advanced_config: {},
    },
  };
}
