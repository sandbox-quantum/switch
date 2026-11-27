/**
 * Decision routing wire types: how a workspace chooses which agent answers
 * untagged messages in auto-route rooms.
 */

export type DecisionBackend = 'none' | 'endpoint' | 'haiku_anthropic' | 'haiku_bedrock';

export type DecisionSettings = {
  source: 'workspace' | 'server_default';
  effective: {
    backend: DecisionBackend;
    endpoint: string | null;
    threshold: number | null;
    available: boolean;
    reason: string | null;
  };
  workspace: {
    backend: DecisionBackend;
    endpoint: string | null;
    threshold: number | null;
    hasApiKey: boolean;
    apiKeyLast4: string | null;
    apiKeyUnreadable: boolean;
    updatedAt: string;
  } | null;
  serverDefault: { configured: boolean; endpoint: string | null; hasApiKey: boolean };
  options: { haikuAnthropic: boolean; haikuBedrock: boolean };
};

export type DecisionSettingsInput = {
  backend: DecisionBackend;
  endpoint?: string | null;
  apiKey?: string;
  clearApiKey?: boolean;
  threshold?: number | null;
};

export type DecisionTestInput = DecisionSettingsInput | { backend: 'default' };

export type DecisionTestOutcome = {
  ok: boolean;
  agent: string | null;
  modelChoice: string | null;
  confidence: number | null;
  latencyMs: number | null;
  backend: string | null;
  error: { code: string; message: string } | null;
};

export type GetDecisionSettingsResult =
  | { kind: 'loaded'; settings: DecisionSettings }
  | { kind: 'unauthenticated'; message?: string }
  | { kind: 'forbidden'; message?: string }
  | { kind: 'unsupported'; message?: string };

export type UpdateDecisionSettingsResult =
  | { kind: 'saved'; settings: DecisionSettings }
  | { kind: 'unauthenticated'; message?: string }
  | { kind: 'forbidden'; message?: string }
  | { kind: 'unsupported'; message?: string };

export type ClearDecisionSettingsResult =
  | { kind: 'cleared'; settings: DecisionSettings }
  | { kind: 'unauthenticated'; message?: string }
  | { kind: 'forbidden'; message?: string }
  | { kind: 'unsupported'; message?: string };

export type TestDecisionSettingsResult =
  | { kind: 'tested'; outcome: DecisionTestOutcome }
  | { kind: 'unauthenticated'; message?: string }
  | { kind: 'forbidden'; message?: string }
  | { kind: 'unsupported'; message?: string };
