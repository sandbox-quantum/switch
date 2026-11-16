// Agent management: the machines (agent controllers) that run managed agents,
// the agents placed on them, and the operations sent to them. Served under
// /gateway/management only when the server turns on its agent_management flag,
// except the provider list and advanced-configuration fields, which are always
// served; every failure comes back as {"error": {"code", "message", "retryable"}}.

const BASE = "/gateway/management";

/** A provider's id, one of those `fetchProviders` lists. */
export type Provider = string;

/** One field of a provider's advanced configuration, as the server describes it. */
export interface AdvancedField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean" | "list" | "select";
  help: string | null;
  placeholder: string | null;
  /** A select's choices, the first (value "") meaning unset; null for other types. */
  options: { value: string; label: string }[] | null;
  catalogue: { kind: "model" | "model-variant"; model_field?: string } | null;
}

/** A provider a definition can name. */
export interface ProviderInfo {
  id: Provider;
  label: string;
  advanced_fields: AdvancedField[];
}

export type DesiredState = "running" | "stopped";
export type Isolation = "shared" | "isolated";
/**
 * `online`: its controller's socket to Switch is attached. `offline`: it was
 * connected and is not now (stopped, asleep, cut off, or the Switch server
 * holding it went away). `unknown`: it has never connected. `revoked`: removed
 * from Switch.
 */
export type ControllerState = "online" | "offline" | "unknown" | "revoked";

/** The machine's connection as Switch last recorded it: the current one, or the last. */
export interface ControllerConnection {
  /** When its socket last attached. */
  connected_at: string;
  /** Null while it is connected, and when the Switch server holding it was lost long ago. */
  disconnected_at: string | null;
  /**
   * Null while it is connected; else `socket_closed`, `heartbeat_lapsed`, `taken_over`,
   * `revoked`, `server_shutdown` or `server_lost`.
   */
  disconnect_reason: string | null;
}

export interface Platform {
  os: string;
  arch: string;
  os_version: string;
}

export interface ProviderStatus {
  provider: string;
  installed: boolean;
  version: string | null;
  auth: "ok" | "expired" | "missing" | "unknown" | string;
  auth_source: string | null;
  checked_at: string;
  reason?: string | null;
}

export interface AgentStatus {
  agent_id: string;
  applied_revision: number | null;
  process: string;
  attached: boolean;
  sessions: { active: number; ids: string[] };
  restarts_10m: number;
  oom_kills: number;
  since: string;
  reason?: string | null;
  detail?: string | null;
}

export interface StatusReport {
  seq: number;
  observed_at: string;
  controller: {
    version: string;
    protocol: number;
    assignment_revision: number;
    /** Who moves it onto another release; absent from older controllers. */
    updated_by?: "self" | "console";
  };
  machine: {
    platform: Platform;
    disk_free_bytes: number;
    disk_total_bytes: number;
    mem_free_bytes: number;
    mem_total_bytes: number;
    sessions_running: number;
    sessions_max: number;
  };
  providers: ProviderStatus[];
  tools: { tool: string; state: string; reason?: string | null }[];
  agents: AgentStatus[];
  /** Why the controller does not run the release Switch names yet; absent when it does, and from older controllers. */
  update?: ControllerUpdate | null;
}

export interface ControllerUpdate {
  /** The version it is moving to. */
  target: string;
  state: "waiting_idle" | "failed" | "restart_needed";
  problem?: string | null;
}

/** The controller release Switch tells a machine to run, and whether it runs it. */
export interface ControllerReleaseState {
  wanted: string;
  /** The version it last reported; null before it has reported one. */
  running: string | null;
  current: boolean;
}

export interface Controller {
  id: string;
  name: string;
  /** What its owner says the machine is for; null when none was given. */
  description: string | null;
  kind: "console" | "daemon" | "ec2";
  platform: Platform | null;
  version: string | null;
  state: ControllerState;
  /** When it last reported its status. */
  last_seen_at: string | null;
  /** Null when it has never connected. */
  connection: ControllerConnection | null;
  status: StatusReport | null;
  /** Null when Switch names no release for it, as for a Switch Console machine, which updates with Console. */
  release: ControllerReleaseState | null;
  assignment_revision: number;
  created_at: string;
  revoked_at: string | null;
  /** What the caller may do to it: rename, describe and ask it to re-check
   * its providers; and revoke it. */
  can_edit: boolean;
  can_remove: boolean;
}

export interface Definition {
  provider: Provider;
  model: string | null;
  instructions: string;
  /** The provider's own automatic review: safe actions run, risky ones still ask. */
  auto_mode: boolean;
  /** Bypass: every permission check skipped. Wins over `auto_mode`. */
  auto_approve: boolean;
  directory: string | null;
  isolation: Isolation;
  /** The provider's advanced configuration, as Switch Console edits it; unset fields are absent. */
  advanced_config: Record<string, string | number | boolean | string[]>;
}

export interface ManagedAgent {
  agent_id: string;
  name: string;
  display_name: string | null;
  icon_url: string | null;
  description: string;
  controller_id: string | null;
  controller_state: ControllerState | null;
  desired_state: DesiredState;
  revision: number;
  definition: Definition;
  status: AgentStatus | null;
  created_at: string;
  updated_at: string;
  /** What the caller may do to it: start, stop, restart and edit it; and
   * stop managing it. */
  can_edit: boolean;
  can_delete: boolean;
}

export interface Operation {
  id: string;
  controller_id: string;
  agent_id: string | null;
  kind: string;
  params: Record<string, unknown>;
  state: "pending" | "claimed" | "succeeded" | "failed" | "cancelled" | "expired";
  lease_expires_at: string | null;
  result: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface EnrollmentCode {
  code: string;
  expires_at: string;
  /**
   * The Switch API address a controller enrolls against, as the server is
   * configured with it (`GATEWAY_PUBLIC_URL`); null when it is not. This
   * page's own address is no stand-in: a gateway need not serve the agent API.
   */
  server_url: string | null;
}

/** A refusal from a management route, with the contract's reason code. */
export class ManagementApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagementApiError";
  }
}

/** Reads the error envelope, falling back to the status line for anything else. */
export async function managementError(res: Response): Promise<ManagementApiError> {
  const body: unknown = await res.json().catch(() => null);
  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : null;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" && typeof message === "string")
      return new ManagementApiError(res.status, code, message);
  }
  return new ManagementApiError(res.status, "http_error", `${res.status} ${res.statusText}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) throw await managementError(res);
  return (await res.json()) as T;
}

export function fetchControllers(): Promise<Controller[]> {
  return request<Controller[]>("/controllers");
}

export function createEnrollmentCode(): Promise<EnrollmentCode> {
  return request<EnrollmentCode>("/enrollment-codes", { method: "POST" });
}

export const MAX_MACHINE_NAME = 200;
export const MAX_MACHINE_DESCRIPTION = 500;

/**
 * Rename a machine and/or change its description. A key left out is left as
 * it is; `description: null` clears it.
 */
export function updateController(
  controllerId: string,
  body: { name?: string; description?: string | null },
): Promise<Controller> {
  return request<Controller>(`/controllers/${encodeURIComponent(controllerId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function revokeController(controllerId: string): Promise<void> {
  await request<{ ok: boolean }>(`/controllers/${encodeURIComponent(controllerId)}`, {
    method: "DELETE",
  });
}

/** Every provider the server runs, in the order to offer them. */
export async function fetchProviders(): Promise<ProviderInfo[]> {
  return (await request<{ providers: ProviderInfo[] }>("/providers")).providers;
}

/** The provider's label, or its id when the server does not list it. */
export function providerLabel(providers: ProviderInfo[], provider: Provider): string {
  return providers.find((p) => p.id === provider)?.label ?? provider;
}

export function fetchManagedAgents(): Promise<ManagedAgent[]> {
  return request<ManagedAgent[]>("/agents");
}

export function createManagedAgent(body: {
  name: string;
  description: string;
  display_name: string | null;
  controller_id: string | null;
  desired_state: DesiredState;
  definition: Definition;
}): Promise<ManagedAgent> {
  return request<ManagedAgent>("/agents", { method: "POST", body: JSON.stringify(body) });
}

export function updateManagedAgent(
  agentId: string,
  body: { definition?: Definition; desired_state?: DesiredState; controller_id?: string | null },
): Promise<ManagedAgent> {
  return request<ManagedAgent>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function unmanageAgent(agentId: string): Promise<void> {
  await request<{ ok: boolean }>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

export function fetchOperations(): Promise<Operation[]> {
  return request<Operation[]>("/operations");
}

export function createOperation(body: {
  controller_id: string;
  agent_id: string | null;
  kind: "agent.restart" | "provider.recheck";
  params: Record<string, unknown>;
}): Promise<Operation> {
  return request<Operation>("/operations", { method: "POST", body: JSON.stringify(body) });
}

/** What a device is, as people tell them apart. */
export type DeviceType = "computer" | "remote_ssh" | "cloud";

/** A device in the workspace's list, as the caller may see it: everyone's to
 *  an admin, their own to anyone else. Removed devices are left out. */
export interface WorkspaceDevice {
  id: string;
  name: string;
  description: string | null;
  kind: Controller["kind"];
  type: DeviceType;
  platform: Platform | null;
  version: string | null;
  state: ControllerState;
  last_seen_at: string | null;
  created_at: string;
  owner_id: string;
  owner_name: string;
  /** The providers it last reported, by id. */
  providers: Provider[];
  agents_total: number;
  agents_running: number;
  /** Rename and describe it; ask it to re-check its providers; remove it.
   *  Its owner does the first two, and its owner or an admin removes it, but
   *  nobody renames or removes a cloud device: Switch does. */
  can_edit: boolean;
  can_recheck: boolean;
  can_remove: boolean;
}

/** A managed agent in the workspace's list, as the caller may see it. */
export interface WorkspaceManagedAgent {
  agent_id: string;
  name: string;
  display_name: string | null;
  provider: Provider;
  controller_id: string | null;
  controller_name: string | null;
  controller_kind: Controller["kind"] | null;
  controller_state: ControllerState | null;
  desired_state: DesiredState;
  /** What its device last reported of it; null before it has, and for one
   *  placed nowhere. */
  process: string | null;
  owner_id: string;
  owner_name: string;
  /** Start, stop, restart and edit it: its owner. Stop managing it, or delete
   *  it: its owner or an admin. */
  can_edit: boolean;
  can_delete: boolean;
}

export interface WorkspaceDevices {
  devices: WorkspaceDevice[];
  managed_agents: WorkspaceManagedAgent[];
  operations: Operation[];
}

export function fetchWorkspaceDevices(): Promise<WorkspaceDevices> {
  return request<WorkspaceDevices>("/workspace");
}

/** Which of the organization's workspaces a row of Organization › Devices is in. */
interface InWorkspace {
  workspace_id: string;
  workspace_name: string;
}

/** Every device and managed agent in the organization's workspaces, as an
 *  admin of each sees them, each saying which workspace it is in. */
export interface OrganizationDevices {
  devices: (WorkspaceDevice & InWorkspace)[];
  managed_agents: (WorkspaceManagedAgent & InWorkspace)[];
}

const ORGANIZATION = "/gateway/organizations/current";

/** A refusal from an Organization › Devices route: the gateway's `detail`
 *  from the checks made first (not an organization admin, a workspace
 *  elsewhere), or the management envelope from the route's own. */
async function organizationError(res: Response): Promise<ManagementApiError> {
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
  if (typeof detail === "string") return new ManagementApiError(res.status, "http_error", detail);
  return managementError(res);
}

async function organizationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ORGANIZATION}${path}`, { ...init, credentials: "include" });
  if (!res.ok) throw await organizationError(res);
  return (await res.json()) as T;
}

export function fetchOrganizationDevices(): Promise<OrganizationDevices> {
  return organizationRequest<OrganizationDevices>("/devices");
}

/** Remove a device in one of the organization's workspaces. */
export async function removeOrganizationDevice(workspaceId: string, controllerId: string): Promise<void> {
  await organizationRequest<{ ok: boolean }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/devices/${encodeURIComponent(controllerId)}`,
    { method: "DELETE" },
  );
}

/** Stop managing an agent in one of the organization's workspaces. */
export async function unmanageOrganizationAgent(workspaceId: string, agentId: string): Promise<void> {
  await organizationRequest<{ ok: boolean }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/managed-agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );
}

/** The caller's cloud machine, as its owner sees it from this workspace. */
export interface CloudMachine {
  machine_id: string;
  state: string;
  desired_state: string;
  stop_reason: string | null;
  stopped_by_admin: boolean;
  sleeping: boolean;
  revision: number;
  error: string | null;
  error_code: string | null;
  retain_until: string | null;
  heartbeat_at: string | null;
  /** The controller it enrolled as here; null until it has. */
  controller_id: string | null;
}

export type CloudMachineAction = "stop" | "start" | "retry";

const HOSTED = "/gateway/hosted-machines";

async function hostedRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HOSTED}${path}`, {
    ...init,
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
    throw new ManagementApiError(
      res.status,
      "http_error",
      typeof detail === "string" ? detail : `${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

/** The caller's cloud machine, when it serves this workspace. */
export async function fetchCloudMachines(): Promise<CloudMachine[]> {
  return (await hostedRequest<{ available: boolean; machines: CloudMachine[] }>("")).machines;
}

/** Stop, start or retry the caller's cloud machine, at the revision they saw. */
export async function cloudMachineLifecycle(
  machineId: string,
  action: CloudMachineAction,
  revision: number,
): Promise<CloudMachine> {
  return (
    await hostedRequest<{ machine: CloudMachine }>(`/${encodeURIComponent(machineId)}/lifecycle`, {
      method: "POST",
      body: JSON.stringify({ action, revision }),
    })
  ).machine;
}

/** One word for a POSIX shell: as it is when nothing in it is special, else single-quoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The enroll options for a machine's name and description, when given (blank is left out: the name then defaults to the host name). */
function machineWords(machine: { name: string; description: string }): string[] {
  const words: string[] = [];
  const name = machine.name.trim();
  const description = machine.description.trim();
  if (name) words.push("--name", name);
  if (description) words.push("--description", description);
  return words;
}

/**
 * The controller's installer, as published on the default branch: it finds the
 * newest `switch-agent-controller` release and installs it with npm.
 */
export const CONTROLLER_INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh";

/** The one command that installs the controller, enrolls the machine with a fresh code and starts it as a service. */
export function installCommand(
  server: string,
  code: string,
  machine: { name: string; description: string },
): string {
  const options = ["--server", server, "--code", code, ...machineWords(machine)];
  return `curl -fsSL ${CONTROLLER_INSTALL_SCRIPT_URL} | sh -s -- ${options.map(shellQuote).join(" ")}`;
}

/** The command a user runs on a machine where the controller is installed already, to enroll it with a fresh code. */
export function enrollCommand(
  server: string,
  code: string,
  machine: { name: string; description: string },
): string {
  const words = ["switch-agent-controller", "enroll", "--server", server, "--code", code, ...machineWords(machine)];
  return words.map(shellQuote).join(" ");
}
