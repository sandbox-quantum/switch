/**
 * Agent template types shared between Console and the gateway.
 */

export type TemplateConnection = {
  service: string;
  access: 'read' | 'write' | null;
  repos: string[];
};

export type AgentTemplateSource = {
  kind: 'builtin' | 'npm' | 'web';
  value: string;
};

export type AgentTemplateAddressing = {
  owner: boolean;
  owner_agents: boolean;
  users: string[];
  agents: string[];
};

export type ParsedAgentEntry = {
  name: string | null;
  displayName: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: AgentTemplateSource[];
  addressing: AgentTemplateAddressing | null;
  provider: string | null;
  location: string | null;
  machine: string | null;
  model: string | null;
  advancedConfig: Record<string, unknown>;
  isolation: string | null;
  autoMode: boolean | string | null;
  autoApprove: boolean | string | null;
  connections: TemplateConnection[];
  directory: string | null;
  join: string[];
  placeholders: string[];
  allowExisting: boolean;
  key: string | null;
  condition: string | null;
};
