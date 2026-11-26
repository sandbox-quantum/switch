export type TemplateRunProblem = {
  slot: string;
  code: string;
  message: string;
};

export type TemplateRunAgent = {
  slot: string;
  name: string;
  description: string;
  displayName: string;
  instructions: string | null;
  provider: string;
  machine: string;
  model: string | null;
  advancedConfig: Record<string, unknown> | null;
  isolation: string | null;
  autoMode: boolean;
  autoApprove: string[];
  directory: string | null;
  addressing: string | null;
  connections: string[];
};

export type ProvisionedRoom = {
  id: string;
  name: string;
  description: string | null;
  created: string;
};

export type TemplateRunResult =
  | {
      kind: 'created';
      createdAgents: {
        slot: string;
        agentId: string;
        name: string;
        machine: { id: string; name: string };
        listening: boolean;
      }[];
      room: ProvisionedRoom | null;
    }
  | {
      kind: 'refused';
      code: string;
      message: string;
      problems: TemplateRunProblem[];
      leftBehind: string[];
    };

export type TemplatesClientDeps = {
  call: (path: string, request: { method?: string; body?: unknown }) => Promise<Response>;
};

export function createTemplatesClient(deps: TemplatesClientDeps) {
  return {
    async runTemplateWithAgents(body: {
      agents: TemplateRunAgent[];
      yamlText: string | null;
      inputs: Record<string, string | number | boolean>;
      templateName: string;
    }): Promise<TemplateRunResult> {
      return postTemplateRun(deps, '/rooms/from-template', {
        agents: body.agents.map((a) => ({
          slot: a.slot,
          name: a.name,
          description: a.description,
          display_name: a.displayName,
          instructions: a.instructions,
          provider: a.provider,
          machine: a.machine,
          model: a.model,
          advanced_config: a.advancedConfig,
          isolation: a.isolation,
          auto_mode: a.autoMode,
          auto_approve: a.autoApprove,
          directory: a.directory,
          addressing: a.addressing,
          connections: a.connections,
        })),
        yaml: body.yamlText,
        inputs: body.inputs,
        template_name: body.templateName,
      });
    },

    async runTemplateDocument(body: {
      template: string;
      inputs: Record<string, string | number | boolean>;
      filled: Record<string, string>;
      templateName: string;
      templateId: string | null;
    }): Promise<TemplateRunResult> {
      return postTemplateRun(deps, '/rooms/from-template-document', {
        template: body.template,
        inputs: body.inputs,
        filled: body.filled,
        template_name: body.templateName,
        ...(body.templateId !== null ? { template_id: body.templateId } : {}),
      });
    },
  };
}

async function postTemplateRun(
  deps: TemplatesClientDeps,
  path: string,
  body: Record<string, unknown>
): Promise<TemplateRunResult> {
  const res = await deps.call(path, { method: 'POST', body });
  if (!res.ok) {
    if (res.status === 409 || res.status === 400) {
      const json = (await res.json().catch(() => ({}))) as {
        code?: string;
        detail?: string;
        problems?: TemplateRunProblem[];
        left_behind?: string[];
      };
      if (json.code && json.detail) {
        return {
          kind: 'refused',
          code: json.code,
          message: json.detail,
          problems: json.problems ?? [],
          leftBehind: json.left_behind ?? [],
        };
      }
      if (json.detail) {
        throw new Error(json.detail);
      }
    }
    throw new Error(`Template run failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    created_agents: {
      slot: string;
      agent_id: string;
      name: string;
      machine: { id: string; name: string };
      listening: boolean;
    }[];
    room: { id: string; name: string; description: string | null; created: string } | null;
  };
  return {
    kind: 'created',
    createdAgents: json.created_agents.map((a) => ({
      slot: a.slot,
      agentId: a.agent_id,
      name: a.name,
      machine: a.machine,
      listening: a.listening,
    })),
    room: json.room,
  };
}
