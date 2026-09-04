import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { Switch } from '@renderer/lib/ui/switch';
import {
  supportsProviderRuntime,
  type AgentProviderConfig,
} from '@shared/core/agents/agent-provider-config';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { SessionRuntimeKind } from '@shared/core/sessions/session-transcript';

/** The provider-config key that decides how an agent's sessions are driven. */
export const RUNTIME_KEY = 'runtime';

const PROVIDER: SessionRuntimeKind = 'provider';

/**
 * What the toggle is called, per provider. Each names the thing the session is
 * actually driven through, because that is what the user is choosing: OpenCode
 * has a server with an HTTP API, Claude Code has the Agent SDK.
 */
const COPY: Record<string, { label: string; description: string }> = {
  opencode: {
    label: 'Drive through the OpenCode server (experimental)',
    description:
      'Runs sessions through OpenCode’s API instead of a terminal. Shows a transcript with approvals and questions you can answer here or from the room.',
  },
  claude: {
    label: 'Drive through the Agent SDK (experimental)',
    description:
      'Runs sessions through the Claude Agent SDK instead of a terminal. Shows a transcript with approvals and questions you can answer here or from the room.',
  },
};

/** Whether stored provider config selects the provider runtime. */
export function providerRuntimeEnabled(
  attributes: RepoAgentAttributes | null | undefined
): boolean {
  return attributes?.[RUNTIME_KEY] === PROVIDER;
}

/**
 * Fold the toggle into collected attributes.
 *
 * Off writes nothing rather than `'pty'`: an unset value leaves the decision
 * where it already is — with the app's default — and an agent that specializes
 * nothing still gets no launch profile at all.
 */
export function withProviderRuntime(
  attributes: RepoAgentAttributes,
  enabled: boolean
): RepoAgentAttributes {
  if (!enabled) {
    const { [RUNTIME_KEY]: _unset, ...rest } = attributes;
    return rest;
  }
  return { ...attributes, [RUNTIME_KEY]: PROVIDER };
}

/**
 * The same fold, against the config the creation form assembles.
 *
 * The launch-profile section returns null when every field is blank, so turning
 * this on may be the only thing set — in which case the config has to be built
 * here rather than merged into one that does not exist.
 */
export function providerConfigWithRuntime(
  config: AgentProviderConfig | null,
  providerId: AgentProviderId | null,
  enabled: boolean
): AgentProviderConfig | null {
  if (!enabled || !supportsProviderRuntime(providerId) || !providerId) return config;
  return {
    version: '2',
    providerId,
    values: { ...(config?.values ?? {}), [RUNTIME_KEY]: PROVIDER },
  };
}

/**
 * Opt an agent out of the terminal and into its provider's own runtime, which
 * is what gives its sessions a transcript instead of a TUI. Renders nothing for
 * an agent type that has no adapter behind it — the same list the main process
 * gates on, so the switch is never offered where it would do nothing.
 */
export function ProviderRuntimeToggle({
  providerId,
  enabled,
  onChange,
  disabled,
}: {
  providerId: AgentProviderId | null;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  const copy = providerId ? COPY[providerId] : undefined;
  if (!supportsProviderRuntime(providerId) || !copy) return null;

  return (
    <Field>
      <FieldLabel htmlFor="agent-provider-runtime" className="justify-between">
        <span>{copy.label}</span>
        <Switch
          id="agent-provider-runtime"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </FieldLabel>
      <FieldDescription className="text-foreground-muted">{copy.description}</FieldDescription>
    </Field>
  );
}
