// Agent management: the machines (agent controllers) that run managed agents,
// the agents placed on them, and the operations sent to them. Served under
// /gateway/management only when the server turns on its agent_management flag;
// every failure comes back as {"error": {"code", "message", "retryable"}}.

const BASE = "/gateway/management";

export type Provider = "claude" | "codex" | "opencode" | "antigravity" | "cursor";
export const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "antigravity", label: "Antigravity" },
  { value: "cursor", label: "Cursor CLI" },
];

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
  controller: { version: string; protocol: number; assignment_revision: number };
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
  assignment_revision: number;
  created_at: string;
  revoked_at: string | null;
}

export interface Definition {
  provider: Provider;
  model: string | null;
  instructions: string;
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

/**
 * Whether this server has agent management turned on. With it off the routes
 * are not mounted at all, so the probe sees the framework's own 404 (no error
 * envelope) rather than a management refusal.
 */
export async function fetchManagementAvailable(): Promise<boolean> {
  const res = await fetch(`${BASE}/controllers`, { credentials: "include" });
  if (res.ok) return true;
  const error = await managementError(res);
  if (res.status === 404 && error.code === "http_error") return false;
  throw error;
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
