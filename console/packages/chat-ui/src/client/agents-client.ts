/**
 * The gateway's `/management` routes for managed agents, machines and
 * providers, called as the signed-in person. Shared between Console's main
 * process and the web dashboard.
 */

export type AgentsRequest = { method?: string; body?: unknown };

export type AgentsClientDeps = {
  call: (path: string, request: AgentsRequest) => Promise<Response>;
};

export type ProviderField = {
  key: string;
  label: string;
  kind: 'string' | 'number' | 'boolean';
  default: string | number | boolean | null;
};

export type Provider = {
  id: string;
  label: string;
  advanced_fields: ProviderField[];
  supports_auto_mode?: boolean;
};

export type ProviderStatus = {
  provider: string;
  installed: boolean;
  version: string | null;
  auth: 'ok' | 'expired' | 'missing' | 'unknown' | string;
  auth_source: string | null;
  checked_at: string;
  reason?: string | null;
  auth_problem?: string | null;
};

export type StatusReport = {
  seq: number;
  observed_at: string;
  controller: {
    version: string;
    protocol: number;
    assignment_revision: number;
    updated_by?: 'self' | 'console';
  };
  machine: {
    platform: { os: string; arch: string; os_version: string };
    disk_free_bytes: number;
    disk_total_bytes: number;
    mem_free_bytes: number;
    mem_total_bytes: number;
    sessions_running: number;
    sessions_max: number;
  };
  providers: ProviderStatus[];
  tools: { tool: string; state: string; reason?: string | null }[];
  agents: {
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
  }[];
  update?: { target: string; state: string; problem?: string | null } | null;
};

export type Machine = {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  state: string;
  status: StatusReport | null;
  can_edit: boolean;
  can_remove: boolean;
};

export type ManagedAgentDefinition = {
  provider: string;
  model: string | null;
  instructions: string;
  auto_mode: boolean;
  auto_approve: boolean;
  directory: string | null;
  isolation: 'shared' | 'isolated';
  advanced_config: Record<string, unknown>;
};

export type ManagedAgentView = {
  agent_id: string;
  name: string;
  display_name: string | null;
  icon_url: string | null;
  description: string;
  controller_id: string | null;
  controller_name: string | null;
  controller_kind: string | null;
  controller_state: string | null;
  desired_state: 'running' | 'stopped';
  revision: number;
  definition: ManagedAgentDefinition;
  status: {
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
    directory?: string | null;
  } | null;
  created_at: string;
  updated_at: string;
  template?: { id: string; key: string; revision?: number | null } | null;
  can_edit: boolean;
  can_delete: boolean;
};

export type ServiceGrant = {
  service: string;
  access: 'read' | 'write';
  repos: string[];
  granted_at: string;
};

export class AgentsClient {
  constructor(private readonly deps: AgentsClientDeps) {}

  private async call(path: string, request: AgentsRequest = {}): Promise<Response> {
    return this.deps.call(path, request);
  }

  private async json<T>(path: string, request: AgentsRequest = {}): Promise<T> {
    return (await this.call(path, request)).json();
  }

  async listProviders(): Promise<Provider[]> {
    return (await this.json<{ providers: Provider[] }>('/management/providers')).providers;
  }

  async listMachines(): Promise<Machine[]> {
    return this.json<Machine[]>('/management/controllers');
  }

  async listManagedAgents(): Promise<ManagedAgentView[]> {
    return this.json<ManagedAgentView[]>('/management/agents');
  }

  async getManagedAgent(agentId: string): Promise<ManagedAgentView> {
    return this.json<ManagedAgentView>(`/management/agents/${encodeURIComponent(agentId)}`);
  }

  async updateManagedAgent(
    agentId: string,
    update: {
      definition?: Partial<ManagedAgentDefinition>;
      desired_state?: 'running' | 'stopped';
      controller_id?: string | null;
    }
  ): Promise<ManagedAgentView> {
    return this.json<ManagedAgentView>(`/management/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: update,
    });
  }

  async listServiceGrants(agentId: string): Promise<ServiceGrant[]> {
    return (
      await this.json<{ grants: ServiceGrant[] }>(
        `/service-connections/agents/${encodeURIComponent(agentId)}/service-grants`
      )
    ).grants;
  }

  async setServiceGrant(
    agentId: string,
    service: string,
    grant: { access: 'read' | 'write'; repos: string[] }
  ): Promise<void> {
    await this.call(
      `/service-connections/agents/${encodeURIComponent(agentId)}/service-grants/${encodeURIComponent(service)}`,
      { method: 'PUT', body: grant }
    );
  }

  async removeServiceGrant(agentId: string, service: string): Promise<void> {
    await this.call(
      `/service-connections/agents/${encodeURIComponent(agentId)}/service-grants/${encodeURIComponent(service)}`,
      { method: 'DELETE' }
    );
  }
}

/**
 * Converts the server's managed agent data to a view matching Console's
 * expectations. The server already returns `ManagedAgentView` from the
 * management routes, so this is an identity transform today, but it exists
 * as the place to handle any needed conversions.
 */
export function toManagedAgentView(serverData: ManagedAgentView): ManagedAgentView {
  return serverData;
}
