import { BUDDY_TEMPLATE_ID, findBuddy } from "@switch-console/chat-ui/model/buddy";
import { createBuddy as createBuddyShared, type TemplateRunResult } from "@switch-console/chat-ui/model/create-buddy";
import { buddyWelcomeMessage } from "@switch-console/chat-ui/model/buddy-welcome-message";
import { type ProviderLogin, sealProviderLogin } from "@switch-console/chat-ui/model/seal-login";
import {
  type CloudMachine,
  type Controller,
  type ManagedAgent,
  ManagementApiError,
  type OperationOutcome,
  cloudMachineLifecycle,
  fetchManagedAgents,
  managementError,
  operationOutcome,
} from "../../data/management";
import { deleteAgent, startOverTestAccount } from "../../data/api";
import { gatewayFetch, ServerTimeout } from "../../data/gatewayFetch";
import { webChatsClient } from "../chats/webChatClient";

/**
 * What getting started on Switch Cloud needs from the server, as Console asks
 * for it: the person's cloud device, an AI provider's login given to it
 * (sealed in the browser to the machine's own key, so Switch only relays it),
 * and switch-buddy made on it from the template the server ships.
 */

const GATEWAY = "/gateway";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const res = await gatewayFetch(`${GATEWAY}${path}`, { ...init, headers });
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/** A refusal in the server's own words: a management envelope, a `detail`, or the status line. */
async function refusal(res: Response): Promise<Error> {
  const copy = res.clone();
  const managed = await managementError(res);
  if (managed.code !== "http_error") return managed;
  const body: unknown = await copy.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "detail" in body
      ? (body as { detail: unknown }).detail
      : null;
  return new ManagementApiError(
    res.status,
    "http_error",
    typeof detail === "string" ? detail : `${res.status} ${res.statusText}`,
  );
}

/** Whether the workspace may have a cloud device on this server, and the person's own when they have one. */
export function fetchHostedMachines(): Promise<{ available: boolean; machines: CloudMachine[] }> {
  return call("/hosted-machines");
}

/**
 * Claims and starts the person's cloud device in the workspace they are in,
 * so it warms before an agent needs it. The server makes this safe to ask
 * again; it refuses, in its own words, when the workspace may have none.
 */
export function ensureCloudMachine(): Promise<CloudMachine> {
  return call<CloudMachine>("/hosted-machines/ensure", { method: "POST" });
}

/** Whether `machine` is asleep, or stopped by its owner, and so is started again for getting started. */
export function needsWaking(machine: CloudMachine): boolean {
  return !machine.stopped_by_admin && (machine.desired_state === "stopped" || machine.sleeping);
}

/** Starts the device again when it is asleep or its owner stopped it; otherwise does nothing. */
export async function wakeCloudMachine(machine: CloudMachine): Promise<void> {
  if (needsWaking(machine))
    await cloudMachineLifecycle(machine.machine_id, "start", machine.revision);
}

/** What every Switch Cloud device installs, so these can be picked before it has reported its own. */
export const CLOUD_DEVICE_PROVIDERS: readonly string[] = ["claude", "codex"];

/**
 * Gives the machine a provider login, sealed here to the machine's own key.
 * Answers the operation the machine takes it up with.
 */
export async function giveMachineLogin(
  controller: Controller,
  provider: string,
  login: ProviderLogin,
): Promise<string> {
  if (!window.isSecureContext)
    throw new Error("Giving the device a login needs this page on HTTPS.");
  const key = controller.public_key;
  if (!key)
    throw new Error(
      "The cloud device has no key to seal a login to yet. Wait for it to finish starting.",
    );
  const sealed = await sealProviderLogin({
    publicKey: key.key,
    controllerId: controller.id,
    provider,
    login,
  });
  const answer = await call<{ operation: { id: string } }>(
    `/management/controllers/${encodeURIComponent(controller.id)}/provider-logins/${encodeURIComponent(provider)}`,
    { method: "PUT", body: JSON.stringify({ sealed }) },
  );
  return answer.operation.id;
}

/** How the cloud device took a login up: still working on it, signed in, or why not. */
export function loginOutcome(controllerId: string, operationId: string): Promise<OperationOutcome> {
  return operationOutcome(controllerId, operationId, {
    expired: "The cloud device did not take the login up in time. Try again.",
    failed: "The cloud device could not sign in with that login.",
  });
}

/** The person's switch-buddy among their own agents, if they have one. */
export function buddyOf(agents: ManagedAgent[] | undefined): ManagedAgent | null {
  return findBuddy(agents);
}

type TemplateRunAnswer = { created_agents: { agent_id: string; name: string }[] };
type TemplateRunRefusal = {
  code: string;
  detail: string;
  problems?: { code: string; message: string }[];
};

/**
 * Creates the person's switch-buddy on their cloud device with `provider`,
 * from the template the server ships. One the person already has is answered instead.
 */
export async function createBuddy(input: {
  controllerId: string;
  provider: string;
  person: { name: string | null; email: string | null };
}): Promise<{ agentId: string; name: string }> {
  return createBuddyShared(input.person, input.provider, input.controllerId, {
    listAgents: async () => {
      const agents = await fetchManagedAgents();
      return agents.map((agent) => ({
        agentId: agent.agent_id,
        name: agent.name,
        template: agent.template,
      }));
    },
    getTemplate: () => call(`/templates/${encodeURIComponent(BUDDY_TEMPLATE_ID)}`),
    runTemplate: async ({ content, name, agentName, provider, machine }): Promise<TemplateRunResult> => {
      const res = await gatewayFetch(`${GATEWAY}/rooms/from-template-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: content,
          inputs: { agent_name: agentName, provider, machine },
          filled: {},
          template_name: name,
          template_id: BUDDY_TEMPLATE_ID,
        }),
      });
      if (res.ok) {
        const created = ((await res.json()) as TemplateRunAnswer).created_agents[0];
        if (!created) return { kind: "failed", message: "Switch created no agent for switch-buddy." };
        return { kind: "created", agentId: created.agent_id, name: created.name };
      }
      const refused =
        res.status === 409
          ? ((await res.json().catch(() => null)) as TemplateRunRefusal | null)
          : null;
      if (refused?.problems?.some((problem) => problem.code === "name_taken"))
        return { kind: "name_taken" };
      if (refused)
        return {
          kind: "failed",
          message: refused.problems?.map((problem) => problem.message).join(" ") || refused.detail,
        };
      throw await refusal(res);
    },
    recordRun: async () => {
      await gatewayFetch(`${GATEWAY}/templates/${encodeURIComponent(BUDDY_TEMPLATE_ID)}/runs`, {
        method: "POST",
      }).catch(() => {});
    },
  });
}

/** How often a start over asks again while a cloud device is being removed, and for how long. */
export const START_OVER_POLL_MS = 5_000;
export const START_OVER_LIMIT_MS = 15 * 60_000;

/**
 * Puts getting started back to its very beginning, for testing it again with
 * the same account on a test server: the server wipes the workspaces only
 * this person is in, with their agents (including switch-buddy), their cloud
 * device (and its sealed provider logins), keeping the sign-in, and signs
 * this browser out. Waits while the device is being removed, asking again
 * until it is done. For workspaces the server skips (TENANT_ZERO_ID and
 * shared workspaces with keep_login=True), cleans up switch-buddy and
 * sealed logins client-side after the server confirms reset.
 */
export async function startOver(input: {
  buddyId: string | null;
  controller: Controller | null;
  email: string;
}): Promise<void> {
  const until = Date.now() + START_OVER_LIMIT_MS;
  for (;;) {
    const progress = await startOverTestAccount(input.email).catch((caught: unknown) => {
      if (caught instanceof ServerTimeout) return null;
      throw caught;
    });
    if (progress?.finished) {
      if (input.buddyId) await deleteAgent(input.buddyId);
      const controller = input.controller;
      if (controller)
        for (const status of controller.status?.providers ?? [])
          if (status.auth_source === "sealed")
            await call(
              `/management/controllers/${encodeURIComponent(controller.id)}/provider-logins/${encodeURIComponent(status.provider)}`,
              { method: "DELETE" },
            );
      return;
    }
    if (Date.now() >= until)
      throw new Error(
        "Your Switch Cloud is still being removed. Try Start over again in a few minutes.",
      );
    await new Promise((resolve) => setTimeout(resolve, START_OVER_POLL_MS));
  }
}

/** The name the buddy's first chat goes by, as Console names it. */
export const WELCOME_CHAT = "Welcome";

/**
 * The buddy's Welcome chat: the one the person has, else one made now with
 * the buddy's welcome as its first message, as Console makes it.
 */
export async function welcomeChat(input: {
  agentId: string;
  agentName: string;
  firstName: string | null;
}): Promise<string> {
  const chats = await webChatsClient.listChats();
  const found = chats.find(
    (chat) =>
      chat.channelType === "direct" &&
      chat.name === WELCOME_CHAT &&
      chat.agents.length === 1 &&
      chat.agents[0]!.id === input.agentId,
  );
  if (found) return found.roomId;
  const chat = await webChatsClient.createChat({
    agentIds: [input.agentId],
    name: WELCOME_CHAT,
    requestId: crypto.randomUUID(),
    greeting: buddyWelcomeMessage({ firstName: input.firstName, agentName: input.agentName }),
  });
  return chat.roomId;
}
